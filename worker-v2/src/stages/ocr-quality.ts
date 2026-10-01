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
 * A missing meta blob or a missing sidecar for a text page is an INVARIANT
 * break, not a degraded case: it throws, and the calling stage's retry /
 * onExhausted path surfaces it — never a silent null that would let a folio
 * read as "not low" because it was never measured.
 *
 * Idempotent and overwriting: the artifact always reflects the current pages.
 */
import type { BlobStore } from "../core/types.js";
import { normalizeCachedDocInfo } from "../bnf/doc-info.js";
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

/** Structural check on a cached pages blob (keys.pages) — a JSON store is not a typed store. */
export function isPreparedPages(v: unknown): v is PreparedPage[] {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        typeof (p as PreparedPage).ordre === "number" &&
        typeof (p as PreparedPage).text === "string",
    )
  );
}

export async function writeOcrQualityArtifact(
  blob: BlobStore,
  doc: Pick<PreparedDoc, "ark" | "lane" | "pages">,
): Promise<DocOcrQuality> {
  const rawMeta = await blob.getJson<unknown>(keys.metadata(doc.ark));
  if (rawMeta === null) {
    throw new Error(`ocr_quality_no_metadata: no meta blob for ${doc.ark}`);
  }
  const info = normalizeCachedDocInfo(rawMeta);
  const source = LANE_SOURCE[doc.lane];

  const folios: FolioOcrQuality[] = [];
  for (const page of [...doc.pages].sort((a, b) => a.ordre - b.ordre)) {
    if (source === OCR_SOURCE.ALTO) {
      const sidecar = await blob.getJson<unknown>(keys.altoQuality(doc.ark, page.ordre));
      if (sidecar === null || !isAltoFolioQuality(sidecar)) {
        throw new Error(
          `ocr_quality_missing_sidecar: ${doc.ark} f${page.ordre} has no ALTO quality sidecar`,
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
    ocrRate: info.ocrRate,
    lane: doc.lane,
    folios,
    builtAt: new Date().toISOString(),
  };
  await blob.putJson(keys.ocrQuality(doc.ark), artifact);
  return artifact;
}
