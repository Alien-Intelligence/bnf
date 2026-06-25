/**
 * Token-bucket rate limiter with 429 penalty support.
 *
 * Mirrors the worker's proven TokenBucket (FIFO promise chain, monotonic time)
 * and adds `penalizeUntil()`: when BnF returns 429 with an absolute `Retry-After`
 * date, the broker freezes the offending bucket until that instant so it stops
 * sending rather than retry-storming. Monotonic `performance.now()` drives the
 * refill; the 429 penalty is an absolute wall-clock deadline (Date.now()).
 */

export interface TokenBucketOptions {
  /** Steady-state requests per minute. */
  rpm: number;
  /** Maximum tokens that can accumulate (burst headroom). */
  burst: number;
}

/**
 * Thrown by `acquire()` when capacity won't be available within the caller's
 * wait budget. The broker maps this to an HTTP 429 so the caller backs off
 * (its retry policy treats 429 as transient) rather than queueing behind a
 * multi-minute 429-freeze — the §14 unbounded-await anti-pattern.
 */
export class RateWaitTimeoutError extends Error {
  constructor(public readonly neededMs: number) {
    super(`rate budget exhausted: capacity needs ~${Math.round(neededMs)}ms, over wait limit`);
    this.name = "RateWaitTimeoutError";
  }
}

export class TokenBucket {
  private readonly rps: number;
  private readonly burst: number;
  private tokens: number;
  private lastRefill: number;
  /** Absolute epoch-ms until which this bucket is frozen by a 429, or 0. */
  private pausedUntilEpochMs = 0;
  /** FIFO chain so acquirers pick up tokens in arrival order, not racing. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.rpm) || opts.rpm <= 0) {
      throw new Error(`TokenBucket: rpm must be > 0, got ${opts.rpm}`);
    }
    if (!Number.isFinite(opts.burst) || opts.burst < 1) {
      throw new Error(`TokenBucket: burst must be >= 1, got ${opts.burst}`);
    }
    this.rps = opts.rpm / 60;
    this.burst = opts.burst;
    this.tokens = opts.burst;
    this.lastRefill = performance.now();
  }

  /**
   * Block until one token is available (and any 429 penalty has elapsed), but
   * no longer than `maxWaitMs` — beyond that the bucket is too contended or
   * frozen, and the caller is SHED (`RateWaitTimeoutError`) so it backs off
   * instead of queueing behind the freeze window. The FIFO chain is preserved
   * (a shed acquirer still advances the chain), so a freeze drains fast as a
   * burst of fast rejections rather than a pile of multi-minute sleeps.
   */
  acquire(maxWaitMs: number): Promise<void> {
    const next = this.chain.then(() => this.consumeOne(maxWaitMs));
    this.chain = next.catch(() => undefined); // never poison the queue
    return next;
  }

  /** Freeze the bucket until `epochMs` (absolute) — called on upstream 429/403. */
  penalizeUntil(epochMs: number): void {
    if (epochMs > this.pausedUntilEpochMs) this.pausedUntilEpochMs = epochMs;
  }

  private async consumeOne(maxWaitMs: number): Promise<void> {
    const start = performance.now();

    // Honour a 429/403 freeze first (absolute wall-clock). If the freeze alone
    // outlasts the wait budget, shed immediately so the queued callers behind
    // us in the chain also re-evaluate and shed fast.
    const penaltyMs = this.pausedUntilEpochMs - Date.now();
    if (penaltyMs > 0) {
      if (penaltyMs > maxWaitMs) throw new RateWaitTimeoutError(penaltyMs);
      await sleep(penaltyMs);
    }

    // Spin until a whole token is actually available — re-checking after each
    // sleep, because a single blind decrement could over-issue past the cap
    // (the bucket must err LOW to stay under the BnF ceiling) — or until the
    // wait budget is exhausted.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = (deficit / this.rps) * 1000;
      if (performance.now() - start + waitMs > maxWaitMs) {
        throw new RateWaitTimeoutError(waitMs);
      }
      await sleep(waitMs);
    }
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rps);
    this.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a BnF `Retry-After` into an absolute epoch-ms freeze deadline.
 *
 * BnF *documents* an absolute GMT HTTP-date, but in practice the 429 carries a
 * **French-localized** date ("mar.", "juin"…) that `Date.parse` returns NaN for.
 * A flat `fallbackMs` (60s) freeze on every such 429 is catastrophic when we run
 * AT the provisioned ceiling (global=300): BnF 429s roughly once a minute, so a
 * 60s freeze of the whole bucket stalls ~all traffic continuously (observed:
 * frozen 60s out of every ~67s → near-total stall).
 *
 * BnF enforces FIXED CLOCK-MINUTE windows that reset on :00 — capacity returns
 * at the next minute boundary, not 60s after the 429. So when the header is
 * absent or unparseable we freeze only until the **next :00 boundary** (≤60s,
 * usually far less), capped by `fallbackMs`. A bare integer (delta-seconds) or a
 * parseable GMT date is still honored verbatim.
 */
export function retryAfterToEpochMs(header: string | undefined, fallbackMs: number): number {
  const now = Date.now();
  const nextClockMinute = (Math.floor(now / 60_000) + 1) * 60_000;
  // Align-to-boundary fallback, never longer than the configured cap.
  const boundaryFallback = Math.min(nextClockMinute, now + fallbackMs);
  if (!header) return boundaryFallback;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000; // delta-seconds
  const t = Date.parse(trimmed); // HTTP-date (GMT) → epoch-ms
  return Number.isFinite(t) && t > now ? t : boundaryFallback;
}
