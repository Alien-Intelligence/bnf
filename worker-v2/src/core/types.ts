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
 * the envelope is generic. `attempts` counts redeliveries (1 on first delivery)
 * so the base can apply the retry/terminal policy.
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
}

/** Options for a single enqueue. `startAfterMs` defers delivery (pg-boss honours
 *  it; the in-memory queue ignores it and delivers immediately). */
export interface SendOpts {
  startAfterMs?: number;
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
   */
  work<T>(
    queue: string,
    handler: (msg: QueueMessage<T>) => Promise<void>,
    opts: {
      concurrency: number;
      retryLimit?: number;
      retryDelayMs?: number;
      retryBackoff?: boolean;
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
}

/** A rate gate (token bucket). The framework's only pacing primitive. */
export interface RateGate {
  /** Resolve when a token is available; reject/throw only on shutdown. */
  acquire(): Promise<void>;
  readonly ratePerMin: number;
}
