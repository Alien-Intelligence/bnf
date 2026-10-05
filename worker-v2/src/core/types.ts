/**
 * Pipeline contracts — the spine of worker-v2.
 *
 * The whole worker is a set of STAGES connected by QUEUES (buckets). A stage is a
 * pure transform: `consume one item → do the work → (persist heavy bytes to the
 * blob store) → emit pointer(s) to the next queue, or terminal-save`. The base
 * class (core/stage.ts) owns that lifecycle; a concrete stage implements only
 * `process()`. Everything here is deliberately small and explicit so data flow is
 * obvious and each piece is unit-testable in isolation (memory impls of the
 * collaborators ship alongside the real ones).
 */

/**
 * A unit of work on a queue. `payload` is stage-specific (typed per stage);
 * the envelope is generic. `attempts` counts the item's deliveries, this one
 * included (1 on first delivery) — ACROSS copies: a copy sent with
 * `SendOpts.attemptsSpent` counts the deliveries its predecessor spent — so
 * the base can apply the retry/terminal policy.
 */
export interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly attempts: number;
}

/**
 * What a stage decides to do with one item. The base dispatches on `kind`:
 *  - emit → push `items` to the stage's output queue
 *  - done → success with nothing to emit (terminal stage / removal)
 *  - skip → not applicable (e.g. doc not in this lane); no emit, not an error
 *  - fail → error; retried per RetryPolicy unless `terminal` (then mark failed now)
 */
export type StageOutcome<Out> =
  | { readonly kind: "emit"; readonly items: readonly Out[] }
  | { readonly kind: "done" }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string; readonly terminal?: boolean };

export interface RetryPolicy {
  /** Max attempts including the first. */
  readonly attempts: number;
  /** Base backoff in ms (exponential: base * 2^attempt, +jitter). */
  readonly baseMs: number;
  /** Per-delay ceiling in ms. */
  readonly maxDelayMs: number;
}

/** Structured logging — events, never free text, so logs are greppable/queryable. */
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Durable artifact store. Heavy payloads (manifest JSON, ALTO XML, image bytes)
 * live here keyed deterministically; the queue only ever carries small pointers.
 * `has()` is the idempotency primitive — "did this work already happen?".
 */
export interface BlobStore {
  has(key: string): Promise<boolean>;
  getJson<T>(key: string): Promise<T | null>;
  getBytes(key: string): Promise<Buffer | null>;
  putJson(key: string, value: unknown): Promise<void>;
  putBytes(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  /**
   * Delete a key. Idempotent — deleting an already-absent key is success, not
   * an error (F15, ai-memories/tech/repos/bnf/ingest-hardening): un-poisoning a
   * dead OCR batch handle (see stages/ocr-poll.ts) must never itself become a
   * new failure mode on a redelivered/duplicate delete.
   */
  delete(key: string): Promise<void>;
}

/** Options for a single enqueue. `startAfterMs` defers delivery (pg-boss honours
 *  it; the in-memory queue ignores it and delivers immediately). */
export interface SendOpts {
  startAfterMs?: number;
  /**
   * Deliveries of this item an earlier copy already spent (a hand-back,
   * core/stage.ts). The copy's deliveries report `attempts` counting them, and
   * its retry budget is reduced by them, so an item never gets more deliveries
   * than its stage's policy allows — however many restarts hand it back — and
   * the final one is still recognised as final (`onExhausted`). A
   * non-negative integer; the queue must have a `work()` policy registered.
   */
  attemptsSpent?: number;
}

/** Queue transport. One queue == one bucket == one stage's input. */
export interface QueueClient {
  /** Enqueue one item onto `queue`. */
  send<T>(queue: string, payload: T, opts?: SendOpts): Promise<void>;
  /** Enqueue many (batch fan-out). */
  sendMany<T>(queue: string, payloads: readonly T[]): Promise<void>;
  /**
   * Subscribe a handler; `concurrency` items processed in parallel. A handler
   * that throws is redelivered up to `retryLimit` times (at-least-once), then the
   * message is marked failed. `retryDelayMs`/`retryBackoff` pace the redeliveries.
   * `expireInSeconds` is the transport's wall-clock ceiling on ONE delivery — see
   * the field's doc on PipelineStage (core/stage.ts) for why every stage declares
   * it explicitly.
   */
  work<T>(
    queue: string,
    handler: (msg: QueueMessage<T>) => Promise<void>,
    opts: {
      concurrency: number;
      retryLimit?: number;
      retryDelayMs?: number;
      retryBackoff?: boolean;
      expireInSeconds?: number;
    },
  ): Promise<void>;
  /** Count items by state for the progress read-model (GLOBAL — all runs). */
  counts(queue: string): Promise<QueueCounts>;
  /**
   * Run-scoped counts: only jobs whose payload `docJobId` is in the given set.
   * The buckets are shared across concurrently-running ingests, so the progress
   * read-model uses this (not `counts`) to keep one run's card from showing
   * another run's bucket activity. Only `running`/`queued` are meaningful (the
   * card uses them); `completed`/`failed` come from the run-scoped doc-state.
   */
  countsForDocs(queue: string, docJobIds: readonly string[]): Promise<QueueCounts>;
  /**
   * Which of `docJobIds` still have a LIVE job (queued, in-flight, or awaiting a
   * retry) on any of `queues`. The reconciliation sweep (live/reconciler.ts) asks
   * this to tell "this doc is still being worked on" from "this doc's job is GONE
   * and nothing will ever move it again" — the orphan class the 2026-08-11 wedge
   * created (a pg-boss EXPIRED job runs no handler code, so no in-handler idiom
   * can mark the doc; see F7 in ai-memories/tech/repos/bnf/ingest-hardening).
   *
   * Batched by contract: ONE call per sweep, not one per doc. An empty
   * `docJobIds` returns an empty set without touching the transport.
   */
  liveDocJobIds(
    queues: readonly string[],
    docJobIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /**
   * Shutdown phase 1: stop taking new deliveries and wait up to `budgetMs` for
   * the in-flight handlers. The transport STAYS USABLE — `send` still works —
   * so a handler that hands its delivery back during shutdown can. Returns how
   * many handlers are still in flight. Callable more than once.
   */
  drain(budgetMs: number): Promise<number>;
  /**
   * Shutdown phase 2: close the transport. A handler still running after it
   * can no longer complete or fail its delivery: its job is left to expire.
   */
  stop(): Promise<void>;
}

export interface QueueCounts {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
}

/** Collaborators handed to `process()` at runtime. */
export interface StageContext {
  readonly blob: BlobStore;
  readonly log: Logger;
  readonly messageId: string;
  /** 1 on first delivery; the base passes the current attempt for backoff/decisions. */
  readonly attempt: number;
  /**
   * Aborts when the delivery reaches its ceiling (the stage's expireInSeconds)
   * with a DeliveryExpiredError. pg-boss's own expiry only rewrites the job
   * row; this is what actually stops the work — every gate wait, loop and
   * long step of process() honours it.
   */
  readonly signal: AbortSignal;
}

/** A rate gate (token bucket). The framework's only pacing primitive. */
export interface RateGate {
  /**
   * Resolve when a token is available. Reject with RateGateStoppedError on
   * shutdown (a stopped gate never lets a waiter through ungated), or with
   * `signal.reason` when `signal` aborts first — the waiter then gives up its
   * place and consumes no token. The signal is REQUIRED: every gated caller
   * bounds its wait (acquireWithin, core/rate.ts).
   */
  acquire(signal: AbortSignal): Promise<void>;
  readonly ratePerMin: number;
}
