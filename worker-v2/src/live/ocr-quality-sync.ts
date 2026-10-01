/**
 * POST /ocr-quality/sync — the app↔worker pull for OCR quality (plan D7).
 *
 * The app sends up to OCR_SYNC_MAX_ARKS canonical ARKs. For each one:
 *   - the per-ARK artifact exists in S3 → returned in `documents`;
 *   - it is missing and the backfill is enabled → one build is queued, deduped
 *     through the OcrBackfillStore (a queued or recently failed row is never
 *     re-sent) → `building`, or `unavailable` with the recorded failure reason;
 *   - it is missing and the backfill is disabled → `unavailable:
 *     backfill_disabled` (existing artifacts are still served, so the switch
 *     stops the BnF spend without a rollback).
 *
 * Unauthenticated by design (D17), like /ingest: it trusts the cluster network
 * and can at most enqueue rate-gated, idempotent builds, one row per ARK.
 */
import type { BlobStore, Logger, QueueClient } from "../core/types.js";
import { Semaphore } from "../core/semaphore.js";
import { PermanentBnfError } from "../bnf/errors.js";
import { ensureCanonicalArk } from "../bnf/parse.js";
import { keys } from "../domain/keys.js";
import type { OcrBackfillStore } from "../domain/ocr-backfill.js";
import { Q } from "../domain/queues.js";
import type { DocOcrQuality } from "../domain/types.js";
import type { OcrBackfillItem } from "../stages/ocr-quality-backfill.js";

/** ARKs per sync call — mirrors the app's OCR_SYNC_BATCH_SIZE. */
export const OCR_SYNC_MAX_ARKS = 100;
/** Parallel S3 reads per call (small JSON GETs). */
const ARTIFACT_READ_CONCURRENCY = 16;

export const OCR_SYNC_UNAVAILABLE_BACKFILL_DISABLED = "backfill_disabled";

export interface OcrSyncRequest {
  arks: string[];
}

export interface OcrSyncDeps {
  blob: BlobStore;
  backfill: OcrBackfillStore;
  queue: QueueClient;
  log: Logger;
  backfillEnabled: boolean;
  /** A failed row older than this is re-queued on request (OCR_BACKFILL_RETRY_FAILED_AFTER_MS). */
  retryFailedAfterMs: number;
}

export interface OcrSyncResponse {
  documents: DocOcrQuality[];
  building: string[];
  unavailable: Array<{ ark: string; reason: string }>;
}

/**
 * Validate the raw body into `{arks}`: 1..OCR_SYNC_MAX_ARKS canonical ARKs,
 * deduped. A discriminated result so the HTTP handler maps a parse failure to
 * a 400 with the specific reason.
 */
export function parseOcrSyncRequest(
  raw: unknown,
): { ok: true; value: OcrSyncRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const arks = (raw as Record<string, unknown>).arks;
  if (!Array.isArray(arks)) return { ok: false, error: "arks must be an array" };
  if (arks.length === 0) return { ok: false, error: "arks must not be empty" };
  if (arks.length > OCR_SYNC_MAX_ARKS) {
    return { ok: false, error: `arks must hold at most ${OCR_SYNC_MAX_ARKS} items` };
  }
  const canonical: string[] = [];
  for (const [i, ark] of arks.entries()) {
    if (typeof ark !== "string") return { ok: false, error: `arks[${i}] must be a string` };
    try {
      canonical.push(ensureCanonicalArk(ark));
    } catch (e) {
      if (e instanceof PermanentBnfError) {
        return { ok: false, error: `arks[${i}]: ${e.message}` };
      }
      throw e;
    }
  }
  return { ok: true, value: { arks: [...new Set(canonical)] } };
}

/** Structural check on a cached artifact — a corrupt one is rebuilt, not served. */
function isDocOcrQuality(v: unknown, ark: string): v is DocOcrQuality {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return a.v === 1 && a.ark === ark && Array.isArray(a.folios) && typeof a.builtAt === "string";
}

export async function syncOcrQuality(deps: OcrSyncDeps, arks: string[]): Promise<OcrSyncResponse> {
  const reads = new Semaphore(ARTIFACT_READ_CONCURRENCY);
  const artifacts = await Promise.all(
    arks.map((ark) => reads.run(() => deps.blob.getJson<unknown>(keys.ocrQuality(ark)))),
  );

  const response: OcrSyncResponse = { documents: [], building: [], unavailable: [] };
  for (const [i, ark] of arks.entries()) {
    const artifact = artifacts[i];
    if (artifact !== null && artifact !== undefined) {
      if (isDocOcrQuality(artifact, ark)) {
        response.documents.push(artifact);
        continue;
      }
      deps.log.warn("ocr_quality_artifact_corrupt", { ark, key: keys.ocrQuality(ark) });
    }
    if (!deps.backfillEnabled) {
      response.unavailable.push({ ark, reason: OCR_SYNC_UNAVAILABLE_BACKFILL_DISABLED });
      continue;
    }
    const decision = await deps.backfill.request(ark, deps.retryFailedAfterMs);
    switch (decision.kind) {
      case "enqueue": {
        const item: OcrBackfillItem = { ark };
        await deps.queue.send(Q.ocrQualityBackfill, item);
        response.building.push(ark);
        break;
      }
      case "queued":
        response.building.push(ark);
        break;
      case "failed":
        response.unavailable.push({ ark, reason: decision.reason });
        break;
    }
  }
  return response;
}
