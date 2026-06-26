/**
 * Token-bucket rate gate — the pipeline's one pacing primitive (generalises the
 * V1 fetch-gate). Each stage that touches a capped external API owns one: the
 * IIIF manifest stage at 42/min, the BnF fetch stage at 300/min, etc.
 *
 * Pure concurrency/rate math, no I/O. The clock is injectable (`now`) so the
 * token arithmetic is unit-testable without real waiting; `tryAcquire()` is the
 * synchronous core, `acquire()` wraps it with FIFO waiters for real use.
 */
import type { RateGate } from "./types.js";

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
  private readonly waiters: Array<() => void> = [];
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

  /** Acquire one token, waiting (FIFO) if the bucket is empty. */
  acquire(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("RateLimiter stopped"));
    if (this.waiters.length === 0 && this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
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
      const next = this.waiters.shift();
      next?.();
    }
    if (this.waiters.length > 0) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Release any blocked acquirers so shutdown doesn't hang.
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }
}
