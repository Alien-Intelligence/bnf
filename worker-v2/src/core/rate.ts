/**
 * Token-bucket rate gate — the pipeline's one pacing primitive (generalises the
 * V1 fetch-gate). Each stage that touches a capped external API owns one; a
 * BnF call that spends several nested quotas (an API's quota inside the
 * subscription's global cap, a manifest inside both) holds a CompositeRateGate
 * over the gates of those quotas, mirroring the broker's buckets.
 *
 * Pure concurrency/rate math, no I/O. The clock is injectable (`now`) so the
 * token arithmetic is unit-testable without real waiting; `tryAcquire()` is the
 * synchronous core, `acquire()` wraps it with FIFO waiters for real use.
 */
import type { RateGate } from "./types.js";

/** The gate was stopped (shutdown) while — or before — a caller waited. */
export class RateGateStoppedError extends Error {
  constructor() {
    super("rate gate stopped");
    this.name = "RateGateStoppedError";
  }
}

/** A token wait outlived its deadline — the gate is saturated. Retry later. */
export class RateGateTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`no rate-gate token within ${waitedMs}ms`);
    this.name = "RateGateTimeoutError";
  }
}

/**
 * Acquire one token from `gate`, or reject with RateGateTimeoutError after
 * `ms` — THE bounded wait every gated caller uses (CLAUDE_ERROR_PATTERNS §14).
 * `signal` (a delivery's ceiling, StageContext.signal) aborts the wait too,
 * with its own reason. The abandoned waiter gives up its place and consumes no
 * token.
 */
export async function acquireWithin(gate: RateGate, ms: number, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RateGateTimeoutError(ms)), ms);
  try {
    await gate.acquire(signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface RateLimiterOpts {
  /** Sustained tokens per minute. */
  ratePerMin: number;
  /** Bucket capacity (burst). Default: ~1 second of rate, min 1. */
  burst?: number;
  /** Injectable clock in ms (default Date.now) — tests drive it deterministically. */
  now?: () => number;
}

export class RateLimiter implements RateGate {
  readonly ratePerMin: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  private tokens: number;
  private last: number;
  private readonly waiters: Array<{ grant: () => void; refuse: (e: Error) => void }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: RateLimiterOpts) {
    if (opts.ratePerMin <= 0) throw new Error(`ratePerMin must be > 0, got ${opts.ratePerMin}`);
    this.ratePerMin = opts.ratePerMin;
    this.refillPerMs = opts.ratePerMin / 60_000;
    this.capacity = Math.max(1, opts.burst ?? Math.ceil(opts.ratePerMin / 60));
    this.now = opts.now ?? Date.now;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  /** Current (refilled) token count — for tests/introspection. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = t;
  }

  /** Synchronous core: consume one token if available. Returns false if empty. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** ms until at least one token is available (0 if available now). */
  msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /** Waiters currently queued — for tests/introspection. */
  pendingWaiters(): number {
    return this.waiters.length;
  }

  /**
   * Acquire one token, waiting (FIFO) if the bucket is empty. An abort of
   * `signal` rejects with its reason and removes the waiter, so an abandoned
   * wait never consumes a token later; stop() rejects every waiter.
   */
  acquire(signal: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.reject(new RateGateStoppedError());
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.waiters.length === 0 && this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        refuse: (e: Error): void => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== null || this.waiters.length === 0 || this.stopped) return;
    const wait = Math.max(1, this.msUntilToken());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.waiters.length > 0 && this.tryAcquire()) {
      this.waiters.shift()?.grant();
    }
    if (this.waiters.length > 0) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Refuse every blocked acquirer so shutdown doesn't hang — never grant
    // them: a waiter let through here would call BnF ungated.
    while (this.waiters.length > 0) this.waiters.shift()?.refuse(new RateGateStoppedError());
  }
}

/**
 * A gate that grants only when EVERY inner gate granted: one token from each,
 * in order — the most specific quota first, the global one last, like the
 * broker's plan (broker/src/plan.ts), so a call waiting on a scarce API quota
 * holds no global token. `ratePerMin` is the binding (smallest) rate.
 *
 * The composite owns nothing: whoever built the inner gates stops them
 * (main.ts), and a stopped inner gate rejects the composite with
 * RateGateStoppedError like any gate. A wait aborted after an earlier inner
 * gate granted leaves that token spent with no request sent — it errs low
 * (under the quota), never over it.
 */
export class CompositeRateGate implements RateGate {
  readonly ratePerMin: number;

  constructor(private readonly gates: readonly RateGate[]) {
    const first = gates[0];
    if (first === undefined) throw new Error("CompositeRateGate needs at least one gate");
    this.ratePerMin = gates.reduce((min, g) => Math.min(min, g.ratePerMin), first.ratePerMin);
  }

  async acquire(signal: AbortSignal): Promise<void> {
    for (const gate of this.gates) await gate.acquire(signal);
  }
}
