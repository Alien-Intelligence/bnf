/**
 * POST /ocr-quality/sync — the app↔worker pull for OCR quality (plan D7).
 *
 * The app sends up to OCR_SYNC_MAX_ARKS canonical ARKs. Every ARK is answered
 * exactly once:
 *   - a VALID artifact in S3 (isDocOcrQuality) → `documents`;
 *   - a missing or corrupt one (wrong shape or not even JSON — logged, never a
 *     batch-wide error) with the backfill enabled → the store decides
 *     (domain/ocr-backfill.ts planRequest): a build is queued or already queued
 *     → `building`; a failure not due for retry → `unavailable` with its reason.
 *     A queue send that fails releases the claim (a retryable failure,
 *     `enqueue_failed: …`) instead of stranding a queued row;
 *   - with the backfill disabled → nothing is queued and the answer says why:
 *     the stored failure reason if there is one, `artifact_corrupt` for a
 *     corrupt artifact, else `backfill_disabled`.
 *
 * Unauthenticated by design (D17), like /ingest: it trusts the cluster network
 * and can at most enqueue rate-gated, idempotent builds, one row per ARK. The
 * server bounds the body (OCR_SYNC_MAX_BODY_BYTES), its read time, the requests
 * in flight (OCR_SYNC_MAX_IN_FLIGHT) and the whole request
 * (OCR_SYNC_DEADLINE_MS): at the deadline its signal aborts, and the per-ARK
 * work stops at its next step — no new S3 read, no new store transaction. A
 * claim already won (`enqueue`) is always followed by its send or its release,
 * never abandoned between the two.
 */
import type { BlobStore, Logger, QueueClient } from "../core/types.js";
import { Semaphore } from "../core/semaphore.js";
import { keys } from "../domain/keys.js";
import {
  OCR_BACKFILL_REASON,
  OCR_BACKFILL_STATE,
  requireReason,
  withDetail,
  type OcrBackfillWiring,
} from "../domain/ocr-backfill.js";
import { Q } from "../domain/queues.js";
import type { DocOcrQuality } from "../domain/types.js";
import type { OcrBackfillItem } from "../stages/ocr-quality-backfill.js";
import { isDocOcrQuality } from "../stages/ocr-quality.js";

/** ARKs per sync call — mirrors the app's OCR_SYNC_BATCH_SIZE. */
export const OCR_SYNC_MAX_ARKS = 100;

/**
 * The one ARK form the endpoint accepts — EXACTLY the app's arkSchema
 * (lib/validation/ark.ts: `ark:/<NAAN digits>/<alphanumeric name>`), any NAAN:
 * whatever ARK the app stores, it may ask about, and an ARK of another NAAN is
 * answered (missing → building/unavailable) rather than failing the whole
 * batch. Never trimmed, never rewritten: the answer is keyed by the ARK as
 * asked, so a rewritten one would never match and be re-asked forever.
 * Padded, empty-name or qualified (`…/f3`) ARKs are a 400 naming `arks[i]`.
 */
export const OCR_SYNC_ARK_PATTERN = /^ark:\/\d+\/[A-Za-z0-9]+$/;

/** Body cap: 100 ARKs of ≤ ~40 bytes plus the envelope fits in a few KiB. */
export const OCR_SYNC_MAX_BODY_BYTES = 16 * 1024;

/** Time allowed to receive the body. */
export const OCR_SYNC_BODY_READ_MS = 10_000;

/**
 * Wall-clock ceiling of one sync request — below the app's 30 s
 * WORKER_RUNNER_TIMEOUT_MS, so the worker answers 503 before the app gives up.
 */
export const OCR_SYNC_DEADLINE_MS = 20_000;

/**
 * Sync requests served at once. The app drains with one request in flight; a
 * few more absorb a retry overlapping a slow answer. Beyond it the endpoint
 * answers 503 at once rather than stacking work on the shared pg pool.
 */
export const OCR_SYNC_MAX_IN_FLIGHT = 2;

/** Parallel per-ARK work (one S3 GET, at most one store transaction + send). */
const OCR_SYNC_WORK_CONCURRENCY = 8;

export const OCR_SYNC_UNAVAILABLE = {
  BACKFILL_DISABLED: "backfill_disabled",
  ARTIFACT_CORRUPT: "artifact_corrupt",
} as const;

/** The declared request body: exactly `{ arks }`, nothing else. */
export const OCR_SYNC_REQUEST_SCHEMA = {
  keys: ["arks"],
  arks: { minItems: 1, maxItems: OCR_SYNC_MAX_ARKS, item: OCR_SYNC_ARK_PATTERN, unique: true },
} as const;

export interface OcrSyncRequest {
  arks: string[];
}

export interface OcrSyncDeps {
  blob: BlobStore;
  queue: QueueClient;
  log: Logger;
  backfill: OcrBackfillWiring;
}

export interface OcrSyncResponse {
  documents: DocOcrQuality[];
  building: string[];
  unavailable: Array<{ ark: string; reason: string }>;
}

/** Validate a raw body against OCR_SYNC_REQUEST_SCHEMA; a discriminated result for a 400. */
export function parseOcrSyncRequest(
  raw: unknown,
): { ok: true; value: OcrSyncRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const allowed = new Set<string>(OCR_SYNC_REQUEST_SCHEMA.keys);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) return { ok: false, error: `unknown keys: ${unknown.join(", ")}` };
  const rule = OCR_SYNC_REQUEST_SCHEMA.arks;
  const arks: unknown = (raw as { arks?: unknown }).arks;
  if (!Array.isArray(arks)) return { ok: false, error: "arks must be an array" };
  if (arks.length < rule.minItems || arks.length > rule.maxItems) {
    return { ok: false, error: `arks must hold ${rule.minItems} to ${rule.maxItems} items, got ${arks.length}` };
  }
  const out: string[] = [];
  for (const [i, ark] of arks.entries()) {
    if (typeof ark !== "string" || !rule.item.test(ark)) {
      return { ok: false, error: `arks[${i}] is not a canonical ark:/<naan>/<name>: ${JSON.stringify(ark)}` };
    }
    out.push(ark);
  }
  if (rule.unique && new Set(out).size !== out.length) {
    return { ok: false, error: "arks must not repeat" };
  }
  return { ok: true, value: { arks: out } };
}

type ArtifactRead = { kind: "valid"; doc: DocOcrQuality } | { kind: "missing" } | { kind: "corrupt" };

async function readArtifact(deps: OcrSyncDeps, ark: string): Promise<ArtifactRead> {
  const bytes = await deps.blob.getBytes(keys.ocrQuality(ark));
  if (bytes === null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (isDocOcrQuality(parsed, ark)) return { kind: "valid", doc: parsed };
  deps.log.warn("ocr_quality_artifact_corrupt", { ark, key: keys.ocrQuality(ark) });
  return { kind: "corrupt" };
}

type Answer =
  | { kind: "document"; doc: DocOcrQuality }
  | { kind: "building" }
  | { kind: "unavailable"; reason: string };

async function answerFor(deps: OcrSyncDeps, ark: string, signal: AbortSignal): Promise<Answer> {
  signal.throwIfAborted();
  const artifact = await readArtifact(deps, ark);
  if (artifact.kind === "valid") return { kind: "document", doc: artifact.doc };

  const { store, enabled, policy } = deps.backfill;
  if (!enabled) {
    signal.throwIfAborted();
    const row = await store.get(ark);
    if (row?.state === OCR_BACKFILL_STATE.FAILED) {
      return { kind: "unavailable", reason: requireReason(row) };
    }
    return {
      kind: "unavailable",
      reason:
        artifact.kind === "corrupt"
          ? OCR_SYNC_UNAVAILABLE.ARTIFACT_CORRUPT
          : OCR_SYNC_UNAVAILABLE.BACKFILL_DISABLED,
    };
  }

  const decision = await store.request(ark, policy, signal);
  switch (decision.kind) {
    case "enqueue": {
      // The claim is won: send it, or release it — whatever the signal says.
      const item: OcrBackfillItem = { ark };
      try {
        await deps.queue.send(Q.ocrQualityBackfill, item);
      } catch (e) {
        return releaseClaim(deps, ark, e);
      }
      return { kind: "building" };
    }
    case "queued":
      return { kind: "building" };
    case "failed":
      return { kind: "unavailable", reason: decision.reason };
  }
}

/**
 * A won claim whose queue send failed: release it as a retryable failure — a
 * queued row nobody will build would read `building` until it went stale.
 * The SEND error is the answer; if the release fails too (the shared DB is
 * down), that is logged next to it, never put in its place — the row then
 * stays queued and the staleness rule recovers it.
 */
async function releaseClaim(deps: OcrSyncDeps, ark: string, sendError: unknown): Promise<Answer> {
  const reason = withDetail(
    OCR_BACKFILL_REASON.ENQUEUE_FAILED,
    sendError instanceof Error ? sendError.message : String(sendError),
  );
  deps.log.error("ocr_quality_enqueue_failed", { ark, error: reason });
  try {
    await deps.backfill.store.markFailed(ark, reason, { permanent: false });
  } catch (releaseError) {
    deps.log.error("ocr_quality_enqueue_release_failed", {
      ark,
      sendError: reason,
      releaseError: releaseError instanceof Error ? releaseError.message : String(releaseError),
    });
  }
  return { kind: "unavailable", reason };
}

/**
 * `work`, or the abort reason as soon as `signal` aborts — the caller answers
 * at the deadline, not when the in-flight step happens to end. The abandoned
 * work stops at its next step (every ARK checks the signal); a failure it
 * still reports afterwards is logged, never unhandled — except the abort
 * itself, which is what stopped it.
 */
async function untilAborted<T>(deps: OcrSyncDeps, work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      work.catch((e: unknown) => {
        if (e === signal.reason) return;
        deps.log.error("ocr_quality_sync_late_failure", { error: e instanceof Error ? e.message : String(e) });
      });
    }
  }
}

/**
 * Answer every ARK. `signal` is the request's deadline: once aborted, no ARK
 * starts a new step and the call rejects with the abort reason.
 */
export async function syncOcrQuality(
  deps: OcrSyncDeps,
  arks: string[],
  signal: AbortSignal,
): Promise<OcrSyncResponse> {
  signal.throwIfAborted();
  const work = new Semaphore(OCR_SYNC_WORK_CONCURRENCY);
  const all = Promise.all(arks.map((ark) => work.run(() => answerFor(deps, ark, signal))));
  const answers = await untilAborted(deps, all, signal);
  const response: OcrSyncResponse = { documents: [], building: [], unavailable: [] };
  answers.forEach((answer, i) => {
    const ark = arks[i];
    if (ark === undefined) throw new Error(`syncOcrQuality: no ARK at index ${i}`);
    if (answer.kind === "document") response.documents.push(answer.doc);
    else if (answer.kind === "building") response.building.push(ark);
    else response.unavailable.push({ ark, reason: answer.reason });
  });
  return response;
}
