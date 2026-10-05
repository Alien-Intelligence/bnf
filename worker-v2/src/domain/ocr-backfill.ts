/**
 * OCR-quality backfill store — one row per ARK whose `ocr-quality/<slug>.json`
 * artifact the app asked for (POST /ocr-quality/sync) while S3 had no valid one.
 * It exists for three things:
 *   - dedupe: however many app sweeps ask for the same missing ARK, at most one
 *     build is queued at a time (`request` is the atomic gate);
 *   - bounded retries: a failed build is retried with exponential backoff up to
 *     OCR_BACKFILL_MAX_ATTEMPTS, a PERMANENT failure (no metadata, no pages,
 *     unclassifiable, a permanent BnF error) is never retried, and a `queued`
 *     row whose build never reported back (pg-boss expired the delivery, which
 *     runs no handler) is re-queued once it is stale — measured from the latest
 *     delivery START, so a long backlog is never mistaken for an expiry — and no
 *     ARK stays `building` forever;
 *   - terminal rows stay terminal and claims are exclusive: every mark is
 *     guarded on `state = 'queued'` AND the claim's `generation` (bumped by
 *     every insert/re-open and carried by the queued message), so a late,
 *     stray or superseded delivery marks nothing (OCR_BACKFILL_MARK);
 *   - progress: `counts()` is what `npm run status` prints.
 *
 * The ARTIFACT is the truth about completion, not the row. `request` is called
 * ONLY when the artifact is missing or invalid (live/ocr-quality-sync.ts checks
 * it — the one place that does); a `done` row reaching `request` therefore lost
 * its artifact and is re-opened — counted as an attempt, so a build whose output
 * keeps vanishing ends as `artifact_lost` instead of looping.
 *
 * Two implementations behind one interface (memory for tests, pg for prod), the
 * same split as doc-state and run-store. Both apply the SAME pure decision
 * (`planRequest`) and are held to one contract test (ocr-backfill.test.ts).
 */

export const OCR_BACKFILL_STATE = {
  QUEUED: "queued",
  DONE: "done",
  FAILED: "failed",
} as const;
export type OcrBackfillState = (typeof OCR_BACKFILL_STATE)[keyof typeof OCR_BACKFILL_STATE];

function isOcrBackfillState(v: unknown): v is OcrBackfillState {
  return (
    v === OCR_BACKFILL_STATE.QUEUED || v === OCR_BACKFILL_STATE.DONE || v === OCR_BACKFILL_STATE.FAILED
  );
}

/** A stored state, validated on read: an unknown value is a corrupt row and throws. */
export function parseOcrBackfillState(v: unknown, ark: string): OcrBackfillState {
  if (!isOcrBackfillState(v)) {
    throw new Error(`ocr_quality_backfill row ${ark}: unknown state ${JSON.stringify(v)}`);
  }
  return v;
}

/** Builds attempted per ARK before its failure is final (failures + expiries + lost artifacts). */
export const OCR_BACKFILL_MAX_ATTEMPTS = 5;

/**
 * Wall-clock ceiling of ONE backfill delivery (the stage's expireInSeconds):
 * a 300-folio worst case, each folio waiting its turn on the shared fetch gate
 * behind live ingests, plus one ALTO fetch (≤ 135 s) each.
 */
export const OCR_BACKFILL_DELIVERY_CEILING_S = 3600;

/**
 * A STARTED queued row (the stage stamped `startedAt` when it picked the
 * delivery up) older than this has no live build: one delivery lasts at most
 * OCR_BACKFILL_DELIVERY_CEILING_S, and a redelivery stamps `startedAt` again —
 * so the 30-minute margin only ever covers the queue's retry delay and clock
 * skew, never a build still running.
 */
export const OCR_BACKFILL_STARTED_STALE_MS = OCR_BACKFILL_DELIVERY_CEILING_S * 1_000 + 30 * 60 * 1_000;

/**
 * A queued claim whose queue send was never confirmed (`sentAt` null: the send
 * failed AND its release failed, or the worker died in between) has no job to
 * wait for — it is re-opened after this, in minutes, not after the backlog
 * rule below. A send that did succeed but was not recorded is harmless: the
 * re-open bumps the generation, so the older message is superseded.
 */
export const OCR_BACKFILL_UNSENT_STALE_MS = 10 * 60 * 1_000;

/**
 * A queued row NO delivery has started is waiting its turn in the backlog —
 * legitimately, however long the backlog. It is only stale once pg-boss itself
 * would have dropped the job unstarted: its default retention (keep_until =
 * created + 14 days, pg-boss 10).
 */
export const OCR_BACKFILL_UNSTARTED_STALE_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * The failure reasons the store and the backfill stage record — the `reason`
 * the app receives for an `unavailable` ARK. A detailed reason is
 * `<reason>: <detail>` (withDetail).
 */
export const OCR_BACKFILL_REASON = {
  /** A queued build never reported back, OCR_BACKFILL_MAX_ATTEMPTS times. */
  EXPIRED: "build_expired",
  /** A built artifact went missing or corrupt OCR_BACKFILL_MAX_ATTEMPTS times. */
  ARTIFACT_LOST: "artifact_lost",
  NO_METADATA: "no_metadata",
  CORRUPT_METADATA: "corrupt_metadata",
  NO_PAGES_ARTIFACT: "no_pages_artifact",
  CORRUPT_PAGES_ARTIFACT: "corrupt_pages_artifact",
  UNCLASSIFIABLE: "unclassifiable",
  BUILD_FAILED: "build_failed",
  ENQUEUE_FAILED: "enqueue_failed",
} as const;
export type OcrBackfillReason = (typeof OCR_BACKFILL_REASON)[keyof typeof OCR_BACKFILL_REASON];

/** `<reason>: <detail>` — a recorded reason carrying what went wrong. */
export function withDetail(reason: OcrBackfillReason, detail: string): string {
  return `${reason}: ${detail}`;
}

export interface OcrBackfillPolicy {
  /** Base backoff before a transient failure is retried; doubles per attempt. */
  retryFailedAfterMs: number;
  /** Total build attempts (failures + expiries + lost artifacts) before a failure is final. */
  maxAttempts: number;
  /** Age (since the last delivery started) after which a started queued row is an expired build. */
  startedStaleAfterMs: number;
  /** Age (since it was queued) after which a sent but never-started row is a lost job. */
  unstartedStaleAfterMs: number;
  /** Age (since it was claimed) after which a claim whose send was never confirmed is re-opened. */
  unsentStaleAfterMs: number;
}

/** A policy with non-positive or fractional values is a configuration error. */
export function validateOcrBackfillPolicy(p: OcrBackfillPolicy): OcrBackfillPolicy {
  for (const [name, v] of Object.entries(p)) {
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new Error(`ocr-backfill policy: ${name} must be a positive integer, got ${String(v)}`);
    }
  }
  return p;
}

export interface OcrBackfillRow {
  ark: string;
  state: OcrBackfillState;
  /** The reason of the last failed build; null otherwise. */
  error: string | null;
  /** True when the last failure can never succeed on a retry. */
  permanent: boolean;
  /** Builds that failed, expired or lost their artifact so far. */
  attempts: number;
  requestedAt: Date;
  /** When the current claim's queue send was confirmed; null until it is. */
  sentAt: Date | null;
  /** When the current build's latest delivery started; null until one does. */
  startedAt: Date | null;
  /** The current claim: bumped by every insert and re-open, carried by its queued message. */
  generation: number;
  updatedAt: Date;
}

/**
 * What `request` decided:
 *   - `enqueue`: the caller owns this ARK's build and must send it to the
 *     backfill queue — and must `markFailed` it if that send fails, so the claim
 *     is released instead of stranding a `queued` row;
 *   - `queued`: a build is already queued — do not send again;
 *   - `failed`: the last build failed and is not due for a retry (or never will
 *     be) — report the reason to the app and do not send.
 */
export type OcrBackfillRequest =
  | { kind: "enqueue"; generation: number }
  | { kind: "queued" }
  | { kind: "failed"; reason: string; permanent: boolean };

/** How `request` must change the stored row — the shared pure decision. */
export type OcrBackfillPlan =
  | { action: "insert" }
  | { action: "reopen"; attempts: number }
  | { action: "expire"; attempts: number; reason: OcrBackfillReason }
  | { action: "report"; result: OcrBackfillRequest };

/**
 * What a mark (start, done, failed) did: `applied` to a queued row, or
 * `not_queued` — the row already left `queued` (a late or stray delivery, a
 * second delivery of a finished build), and a terminal row is never flipped.
 */
export const OCR_BACKFILL_MARK = { APPLIED: "applied", NOT_QUEUED: "not_queued" } as const;

/** A queued claim, as its message carries it: the ARK and the claim's generation. */
export interface OcrBackfillClaim {
  ark: string;
  generation: number;
}
export type OcrBackfillMark = (typeof OCR_BACKFILL_MARK)[keyof typeof OCR_BACKFILL_MARK];

/** Backoff before retrying after `attempts` failures: base × 2^(attempts−1). */
export function retryBackoffMs(policy: OcrBackfillPolicy, attempts: number): number {
  return policy.retryFailedAfterMs * 2 ** Math.max(0, attempts - 1);
}

/** Whether a queued row has no live build any more (see the two stale constants). */
function isStale(row: OcrBackfillRow, policy: OcrBackfillPolicy, now: number): boolean {
  if (row.startedAt !== null) return now - row.startedAt.getTime() >= policy.startedStaleAfterMs;
  if (row.sentAt !== null) return now - row.requestedAt.getTime() >= policy.unstartedStaleAfterMs;
  return now - row.requestedAt.getTime() >= policy.unsentStaleAfterMs;
}

/** Count one more attempt: re-open while attempts remain, else record `reason` for good. */
function retryOrExpire(row: OcrBackfillRow, policy: OcrBackfillPolicy, reason: OcrBackfillReason): OcrBackfillPlan {
  const attempts = row.attempts + 1;
  return attempts >= policy.maxAttempts ? { action: "expire", attempts, reason } : { action: "reopen", attempts };
}

/**
 * The ONE decision `request` makes, applied identically by both stores:
 *   - no row → insert a queued row (enqueue);
 *   - done → its artifact is gone or corrupt (the caller checked): count the
 *     attempt and re-open, or after maxAttempts record `artifact_lost` for good
 *     — a build whose output keeps vanishing must not loop forever;
 *   - queued, live → already queued;
 *   - queued, stale (isStale: measured from the latest delivery START, or from
 *     the enqueue only while no delivery has started) → the build expired:
 *     count the attempt; re-open, or after maxAttempts `build_expired`;
 *   - failed, permanent or out of attempts → report the reason, forever;
 *   - failed, transient, past its backoff → re-open (same attempt count);
 *   - failed, transient, inside its backoff → report the reason.
 */
export function planRequest(
  row: OcrBackfillRow | null,
  policy: OcrBackfillPolicy,
  now: number,
): OcrBackfillPlan {
  if (row === null) return { action: "insert" };
  switch (row.state) {
    case OCR_BACKFILL_STATE.DONE:
      return retryOrExpire(row, policy, OCR_BACKFILL_REASON.ARTIFACT_LOST);
    case OCR_BACKFILL_STATE.QUEUED:
      if (!isStale(row, policy, now)) return { action: "report", result: { kind: "queued" } };
      return retryOrExpire(row, policy, OCR_BACKFILL_REASON.EXPIRED);
    case OCR_BACKFILL_STATE.FAILED: {
      const reason = requireReason(row);
      const final = row.permanent || row.attempts >= policy.maxAttempts;
      if (!final && now - row.updatedAt.getTime() >= retryBackoffMs(policy, row.attempts)) {
        return { action: "reopen", attempts: row.attempts };
      }
      return { action: "report", result: { kind: "failed", reason, permanent: final } };
    }
  }
}

/** A failed row always carries its reason; one without is a corrupt row (the DB CHECK refuses it too). */
export function requireReason(row: Pick<OcrBackfillRow, "ark" | "error">): string {
  if (row.error === null) {
    throw new Error(`ocr_quality_backfill row ${row.ark}: failed without a reason`);
  }
  return row.error;
}

export interface OcrBackfillCounts {
  queued: number;
  done: number;
  failed: number;
}

export interface OcrBackfillStore {
  /**
   * Atomically decide and apply what a request for `ark` does (planRequest).
   * Call ONLY when the artifact is missing or invalid. `signal` aborts before
   * the transaction starts and between its steps (each statement is bounded by
   * the pool's statement_timeout).
   */
  request(ark: string, policy: OcrBackfillPolicy, signal: AbortSignal): Promise<OcrBackfillRequest>;
  /**
   * Every mark below applies only to the row of `claim` — queued AND of the
   * same generation — and answers `not_queued` otherwise (a late, stray or
   * superseded delivery). Each throws when no row exists for the ARK.
   */
  /** The claim's queue send succeeded: stamps `sentAt`. */
  markSent(claim: OcrBackfillClaim): Promise<OcrBackfillMark>;
  /** A delivery of the claim's build started: stamps `startedAt`. */
  markStarted(claim: OcrBackfillClaim): Promise<OcrBackfillMark>;
  /** The build succeeded. */
  markDone(claim: OcrBackfillClaim): Promise<OcrBackfillMark>;
  /**
   * The build failed: stores `reason` and whether it is permanent, increments
   * `attempts`. Also releases an `enqueue` claim whose queue send failed.
   */
  markFailed(claim: OcrBackfillClaim, reason: string, opts: { permanent: boolean }): Promise<OcrBackfillMark>;
  get(ark: string): Promise<OcrBackfillRow | null>;
  counts(): Promise<OcrBackfillCounts>;
}

/**
 * Everything the backfill needs, built ONCE from config (main.ts) and handed to
 * both buildPipeline (registers the stage iff `enabled`) and the HTTP server
 * (enqueues iff `enabled`) — so the endpoint can never queue a build no stage
 * consumes, and the stage never runs when the endpoint is told not to spend.
 */
export interface OcrBackfillWiring {
  store: OcrBackfillStore;
  /** OCR_BACKFILL_ENABLED. */
  enabled: boolean;
  policy: OcrBackfillPolicy;
  /** OCR_BACKFILL_CONCURRENCY — in-flight backfill documents (≥ 1). */
  concurrency: number;
}
