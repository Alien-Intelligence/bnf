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
 * Shared by FetchStage (live ingest: the stage base already acquired its rate
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
}

export interface EnsuredAltoFolio {
  text: string;
  quality: AltoFolioQuality;
  /** True when this call made a BnF request (cache miss or repaired sidecar). */
  fetched: boolean;
}

/** Structural check on a cached sidecar — a corrupt one is a miss, not a crash. */
function isAltoFolioQuality(v: unknown): v is AltoFolioQuality {
  if (v === null || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return (
    q.v === 1 &&
    typeof q.wordCount === "number" &&
    typeof q.scoredWordCount === "number" &&
    (q.meanWc === null || typeof q.meanWc === "number")
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
  const folio = await deps.bnf.fetchAltoFolio(ark, ordre);
  if (folio.invalidWcCount > 0) {
    deps.log.warn("alto_invalid_wc", { ark, ordre, count: folio.invalidWcCount });
  }
  // Text first, sidecar second: a crash between the two leaves a text-only
  // entry, which the next run treats as a miss (D15) — never a sidecar that
  // describes text that was never written.
  await deps.blob.putBytes(textKey, Buffer.from(folio.text, "utf8"), "text/plain; charset=utf-8");
  await deps.blob.putJson(qualityKey, folio.quality);
  return { text: folio.text, quality: folio.quality, fetched: true };
}
