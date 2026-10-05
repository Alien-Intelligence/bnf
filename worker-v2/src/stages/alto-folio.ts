/**
 * ensureAltoFolio — cache-or-fetch ONE folio's ALTO text AND its word-confidence
 * sidecar, as a unit.
 *
 * The S3 "alto" key holds the EXTRACTED TEXT, not the ALTO XML (keys.ts, B1), so
 * the WC word confidences of a folio cached before the OCR-quality release
 * cannot be recovered from the cache: they need one fresh BnF call. Hence plan
 * D15 — a folio counts as cached only when BOTH keys exist. A pre-release
 * text-only entry is a miss, re-fetched exactly once, and complete thereafter.
 *
 * Shared by FetchAltoStage (live ingest: the stage base already acquired its rate
 * token, so no `beforeFetch`) and by OcrQualityBackfillStage (which acquires its
 * token in `beforeFetch`, so a cache hit costs no quota).
 */
import type { BlobStore, Logger } from "../core/types.js";
import type { AltoFolioQuality, BnfClient } from "../bnf/types.js";
import { keys } from "../domain/keys.js";

export interface AltoFolioDeps {
  bnf: BnfClient;
  blob: BlobStore;
  log: Logger;
  /**
   * Awaited right before a BnF fetch — i.e. on a cache miss only. The backfill
   * stage acquires its rate-gate token here, so cache hits stay free.
   */
  beforeFetch?: () => Promise<void>;
  /**
   * The caller's delivery ceiling: after it aborts, nothing of this call is
   * written — no text, no sidecar (the fetch's late answer is discarded).
   */
  signal?: AbortSignal;
}

export interface EnsuredAltoFolio {
  text: string;
  quality: AltoFolioQuality;
  /** True when this call made a BnF request (cache miss or repaired sidecar). */
  fetched: boolean;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Check a cached sidecar against the D1 invariants, not just its field types:
 * non-negative integer counts with scoredWordCount <= wordCount, a mean WC that
 * is a finite number in [0, 1], and a mean present exactly when at least one
 * word is scored. A sidecar failing any of them is corrupt — ensureAltoFolio
 * re-fetches it, the artifact build fails the document.
 */
export function isAltoFolioQuality(v: unknown): v is AltoFolioQuality {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const q = v as Record<string, unknown>;
  if (q.v !== 1 || !isCount(q.wordCount) || !isCount(q.scoredWordCount)) return false;
  if (q.scoredWordCount > q.wordCount) return false;
  if (q.meanWc === null) return q.scoredWordCount === 0;
  return (
    typeof q.meanWc === "number" &&
    Number.isFinite(q.meanWc) &&
    q.meanWc >= 0 &&
    q.meanWc <= 1 &&
    q.scoredWordCount > 0
  );
}

export async function ensureAltoFolio(
  deps: AltoFolioDeps,
  ark: string,
  ordre: number,
): Promise<EnsuredAltoFolio> {
  const textKey = keys.alto(ark, ordre);
  const qualityKey = keys.altoQuality(ark, ordre);
  const [cachedText, cachedQuality] = await Promise.all([
    deps.blob.getBytes(textKey),
    deps.blob.getJson<unknown>(qualityKey),
  ]);

  if (cachedText !== null && cachedQuality !== null) {
    if (isAltoFolioQuality(cachedQuality)) {
      return { text: cachedText.toString("utf8"), quality: cachedQuality, fetched: false };
    }
    deps.log.warn("alto_quality_sidecar_corrupt", { ark, ordre, key: qualityKey });
  }

  if (deps.beforeFetch) await deps.beforeFetch();
  const folio = await deps.bnf.fetchAltoFolio(ark, ordre, deps.signal);
  deps.signal?.throwIfAborted();
  if (folio.invalidWcCount > 0) {
    deps.log.warn("alto_invalid_wc", { ark, ordre, count: folio.invalidWcCount });
  }
  // Text first, sidecar second: a crash between the two leaves a text-only
  // entry, which the next run treats as a miss (D15) — never a sidecar that
  // describes text that was never written.
  await deps.blob.putBytes(textKey, Buffer.from(folio.text, "utf8"), "text/plain; charset=utf-8");
  deps.signal?.throwIfAborted();
  await deps.blob.putJson(qualityKey, folio.quality);
  return { text: folio.text, quality: folio.quality, fetched: true };
}
