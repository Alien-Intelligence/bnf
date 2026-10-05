/**
 * The per-ARK OCR-quality artifact (keys.ocrQuality) — built from a PreparedDoc
 * at every lane's convergence point (assemble / ocr-poll / describe, including
 * describe's cache-hit branch) and by the backfill stage for pre-release docs.
 *
 *   - ocrRate comes from the per-ARK meta blob (keys.metadata), read through
 *     normalizeCachedDocInfo (plan D5: DocMeta is NOT extended);
 *   - text-lane folios take their quality from the ALTO sidecars
 *     (keys.altoQuality) the fetch stage wrote;
 *   - mistral / vision folios record their source with a null quality (D2/D3).
 *
 * A missing or corrupt meta blob, and a missing or corrupt sidecar for a text
 * page, are INVARIANT breaks, not degraded cases and not transient errors: they
 * throw OcrQualityArtifactError, which every caller turns into a TERMINAL
 * failure of the document (failDoc / the backfill store) on the first delivery —
 * retrying cannot make a missing blob appear. Never a silent null that would
 * let a folio read as "not low" because it was never measured.
 *
 * Idempotent and overwriting: the artifact always reflects the current pages.
 */
import type { BlobStore } from "../core/types.js";
import { CorruptDocInfoError, normalizeCachedDocInfo } from "../bnf/doc-info.js";
import { keys } from "../domain/keys.js";
import type { Lane } from "../domain/queues.js";
import {
  OCR_SOURCE,
  type DocOcrQuality,
  type FolioOcrQuality,
  type OcrSource,
  type PreparedDoc,
  type PreparedPage,
} from "../domain/types.js";
import { isAltoFolioQuality } from "./alto-folio.js";

const LANE_SOURCE: Record<Lane, OcrSource> = {
  text: OCR_SOURCE.ALTO,
  vision: OCR_SOURCE.VISION,
  mistral: OCR_SOURCE.MISTRAL,
};

/** Why an artifact could not be built — the failure reason's leading token. */
export const OCR_QUALITY_FAILURE = {
  NO_METADATA: "ocr_quality_no_metadata",
  CORRUPT_METADATA: "ocr_quality_corrupt_metadata",
  MISSING_SIDECAR: "ocr_quality_missing_sidecar",
  CORRUPT_SIDECAR: "ocr_quality_corrupt_sidecar",
  /** The built artifact fails its own contract (isDocOcrQuality) — e.g. duplicate folios. */
  INVALID_ARTIFACT: "ocr_quality_invalid_artifact",
} as const;
export type OcrQualityFailure = (typeof OCR_QUALITY_FAILURE)[keyof typeof OCR_QUALITY_FAILURE];

/** A deterministic artifact-build failure: terminal for the document, never retried. */
export class OcrQualityArtifactError extends Error {
  constructor(
    readonly code: OcrQualityFailure,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "OcrQualityArtifactError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A folio number as the artifact contract accepts it: a positive safe integer. */
function isFolioNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/**
 * Check on a cached pages blob (keys.pages) — a JSON store is not a typed
 * store. As strict as the artifact contract the pages feed (isDocOcrQuality):
 * every `ordre` a positive integer, none repeated, every `text` a string — so a
 * corrupt blob is refused here, not turned into an artifact the sync rejects.
 */
export function isPreparedPages(v: unknown): v is PreparedPage[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<number>();
  for (const p of v) {
    if (!isRecord(p) || !isFolioNumber(p.ordre) || typeof p.text !== "string") return false;
    if (seen.has(p.ordre)) return false;
    seen.add(p.ordre);
  }
  return true;
}

function isFolioOcrQuality(v: unknown, source: OcrSource): v is FolioOcrQuality {
  if (!isRecord(v)) return false;
  if (!isFolioNumber(v.ordre)) return false;
  if (v.ocrSource !== source) return false;
  if (source !== OCR_SOURCE.ALTO) return v.ocrQuality === null && v.wordCount === null;
  const quality = v.ocrQuality;
  const qualityOk =
    quality === null ||
    (typeof quality === "number" && Number.isFinite(quality) && quality >= 0 && quality <= 1);
  const words = v.wordCount;
  return qualityOk && typeof words === "number" && Number.isSafeInteger(words) && words >= 0;
}

/**
 * Full validation of a stored artifact for `ark` — every field and every folio
 * entry, mirroring what the builder writes (and what the app's Zod contract
 * accepts): v1, the matching ARK, a known lane, an ocrRate in [0, 1] or null,
 * unique positive folio numbers whose source matches the lane, ALTO qualities
 * in [0, 1] with integer word counts, null quality and count otherwise.
 */
export function isDocOcrQuality(v: unknown, ark: string): v is DocOcrQuality {
  if (!isRecord(v) || v.v !== 1 || v.ark !== ark) return false;
  if (v.lane !== "text" && v.lane !== "vision" && v.lane !== "mistral") return false;
  const rate = v.ocrRate;
  if (rate !== null && !(typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1)) {
    return false;
  }
  if (typeof v.builtAt !== "string" || Number.isNaN(Date.parse(v.builtAt))) return false;
  if (!Array.isArray(v.folios)) return false;
  const source = LANE_SOURCE[v.lane];
  const seen = new Set<number>();
  for (const f of v.folios) {
    if (!isFolioOcrQuality(f, source) || seen.has(f.ordre)) return false;
    seen.add(f.ordre);
  }
  return true;
}

export async function writeOcrQualityArtifact(
  blob: BlobStore,
  doc: Pick<PreparedDoc, "ark" | "lane" | "pages">,
): Promise<DocOcrQuality> {
  const rawMeta = await blob.getJson<unknown>(keys.metadata(doc.ark));
  if (rawMeta === null) {
    throw new OcrQualityArtifactError(OCR_QUALITY_FAILURE.NO_METADATA, `no meta blob for ${doc.ark}`);
  }
  let ocrRate: number | null;
  try {
    ocrRate = normalizeCachedDocInfo(rawMeta).ocrRate;
  } catch (e) {
    if (!(e instanceof CorruptDocInfoError)) throw e;
    throw new OcrQualityArtifactError(OCR_QUALITY_FAILURE.CORRUPT_METADATA, e.message);
  }
  const source = LANE_SOURCE[doc.lane];

  const folios: FolioOcrQuality[] = [];
  for (const page of [...doc.pages].sort((a, b) => a.ordre - b.ordre)) {
    if (source === OCR_SOURCE.ALTO) {
      const sidecar = await blob.getJson<unknown>(keys.altoQuality(doc.ark, page.ordre));
      if (sidecar === null) {
        throw new OcrQualityArtifactError(
          OCR_QUALITY_FAILURE.MISSING_SIDECAR,
          `${doc.ark} f${page.ordre} has no ALTO quality sidecar`,
        );
      }
      if (!isAltoFolioQuality(sidecar)) {
        throw new OcrQualityArtifactError(
          OCR_QUALITY_FAILURE.CORRUPT_SIDECAR,
          `${doc.ark} f${page.ordre}: the ALTO quality sidecar breaks the D1 invariants`,
        );
      }
      folios.push({
        ordre: page.ordre,
        ocrSource: OCR_SOURCE.ALTO,
        ocrQuality: sidecar.meanWc,
        wordCount: sidecar.wordCount,
      });
    } else {
      folios.push({ ordre: page.ordre, ocrSource: source, ocrQuality: null, wordCount: null });
    }
  }

  const artifact: DocOcrQuality = {
    v: 1,
    ark: doc.ark,
    ocrRate,
    lane: doc.lane,
    folios,
    builtAt: new Date().toISOString(),
  };
  // The artifact the sync will read must pass the sync's own check: never
  // write (and mark done) an artifact /ocr-quality/sync would refuse.
  if (!isDocOcrQuality(artifact, doc.ark)) {
    throw new OcrQualityArtifactError(
      OCR_QUALITY_FAILURE.INVALID_ARTIFACT,
      `${doc.ark}: the built artifact fails isDocOcrQuality (folios ${folios.map((f) => f.ordre).join(",")})`,
    );
  }
  await blob.putJson(keys.ocrQuality(doc.ark), artifact);
  return artifact;
}

/**
 * The convergence-point wrapper: build the artifact, or return the TERMINAL
 * failure reason when the build is impossible (OcrQualityArtifactError). Any
 * other throw (an S3 blip) propagates and is retried like every other stage
 * error. Callers fail the document with the reason (failDoc).
 */
export async function buildOcrQualityArtifact(
  blob: BlobStore,
  doc: Pick<PreparedDoc, "ark" | "lane" | "pages">,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await writeOcrQualityArtifact(blob, doc);
    return { ok: true };
  } catch (e) {
    if (e instanceof OcrQualityArtifactError) return { ok: false, reason: e.message };
    throw e;
  }
}
