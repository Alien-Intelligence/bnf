/**
 * Token-bucket rate limiter with 429 penalty support.
 *
 * Mirrors the worker's proven TokenBucket (FIFO promise chain, monotonic time)
 * and adds `penalizeUntil()`: when BnF returns 429 with an absolute `Retry-After`
 * date, the broker freezes the offending bucket until that instant so it stops
 * sending rather than retry-storming. Monotonic time drives the refill; the 429
 * penalty is an absolute wall-clock deadline.
 *
 * Deadline-from-enqueue (F3, 2026-08-11 incident): `acquire(maxWaitMs)` computes
 * an ABSOLUTE deadline from the monotonic clock BEFORE joining the FIFO chain.
 * `consumeOne` receives that deadline (not a duration) and re-derives the
 * remaining budget from it on every check, so time spent queued behind other
 * acquirers — or frozen behind a 429 penalty — counts against the caller's own
 * wait budget exactly like time spent actually waiting for tokens. Previously
 * the wait clock started only once the chain reached the caller, so queue time
 * was invisible to the budget: a 10s-budget caller observed 65s real waits
 * because 841 calls queued behind a collapsing manifest bucket without ever
 * tripping the shed valve (`RateWaitTimeoutError`→429) that exists precisely to
 * prevent that — it fired 0 times in 2062 logged calls.
 *
 * Both clocks are injectable (constructor `now`/`wallNow`, mirroring
 * worker-v2/src/core/rate.ts's injectable-clock pattern) and so is `sleep`, so
 * the deadline arithmetic is unit-testable without real waiting: a test's
 * injected `sleep` can advance its own fake clock and resolve immediately
 * instead of parking on a real timer.
 */

export interface TokenBucketOptions {
  /** Steady-state requests per minute. */
  rpm: number;
  /** Maximum tokens that can accumulate (burst headroom). */
  burst: number;
  /**
   * Injectable monotonic clock (ms), used for token refill and for measuring
   * the enqueue-time deadline. Defaults to `performance.now()`. Tests drive it
   * deterministically instead of waiting on real time.
   */
  now?: () => number;
  /**
   * Injectable wall clock (ms since epoch), used for `penalizeUntil()`'s
   * absolute freeze deadline (429 `Retry-After` is a wall-clock instant, not a
   * monotonic one). Defaults to `Date.now()`.
   */
  wallNow?: () => number;
  /**
   * Injectable sleep. Defaults to a real `setTimeout`-based wait. Tests can
   * substitute a function that advances their fake `now`/`wallNow` and
   * resolves immediately, so `consumeOne`'s wait loop is exercised without any
   * real elapsed time.
   */
  sleep?: (ms: number) => Promise<void>;
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

  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

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
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? sleep;
    this.lastRefill = this.now();
  }

  /**
   * Block until one token is available (and any 429 penalty has elapsed), but
   * no longer than `maxWaitMs` counted from THIS CALL — beyond that the caller
   * is SHED (`RateWaitTimeoutError`) so it backs off instead of queueing behind
   * a contended bucket or a freeze window.
   *
   * The absolute deadline is computed here, before the caller joins the FIFO
   * chain, so time spent waiting for its turn in the chain counts against the
   * budget exactly like time spent waiting for tokens or a freeze to lift. The
   * chain order is preserved (a shed acquirer still advances the chain, so a
   * frozen bucket drains a queued burst as fast rejections rather than a pile
   * of serial sleeps).
   */
  acquire(maxWaitMs: number): Promise<void> {
    const deadline = this.now() + maxWaitMs;
    const next = this.chain.then(() => this.consumeOne(deadline));
    this.chain = next.catch(() => undefined); // never poison the queue
    return next;
  }

  /** Freeze the bucket until `epochMs` (absolute) — called on upstream 429/403. */
  penalizeUntil(epochMs: number): void {
    if (epochMs > this.pausedUntilEpochMs) this.pausedUntilEpochMs = epochMs;
  }

  /**
   * Try to satisfy one `acquire()` against the absolute `deadline`. Every
   * branch re-derives `remaining = deadline - now()` fresh (never accumulates
   * elapsed-since-start), so a caller that already blew its budget while
   * queued behind the chain — or while asleep on a freeze/refill wait — sheds
   * the moment that's discovered, without an extra sleep first.
   */
  private async consumeOne(deadline: number): Promise<void> {
    for (;;) {
      const remaining = deadline - this.now();

      // Honour a 429/403 freeze first (absolute wall-clock). If the freeze
      // alone outlasts the remaining budget, shed immediately — including the
      // case where the deadline already passed while queued — so callers
      // behind us in the chain also re-evaluate and shed fast rather than
      // sleeping serially through the freeze window.
      const penaltyMs = this.pausedUntilEpochMs - this.wallNow();
      if (penaltyMs > 0) {
        if (penaltyMs > remaining) throw new RateWaitTimeoutError(penaltyMs);
        await this.sleepFn(penaltyMs);
        continue; // re-check deadline + freeze + tokens after waking
      }

      // No active freeze: try to take a token now. Re-checking after every
      // sleep (rather than a single blind decrement) because a stale read
      // could over-issue past the cap — the bucket must err LOW to stay under
      // the BnF ceiling.
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = (deficit / this.rps) * 1000;
      if (waitMs > remaining) throw new RateWaitTimeoutError(waitMs);
      await this.sleepFn(waitMs);
    }
  }

  private refill(): void {
    const now = this.now();
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
 * AT the provisioned ceiling: BnF 429s roughly once a minute, so a 60s freeze of
 * the whole bucket stalls ~all traffic continuously (observed: frozen 60s out of
 * every ~67s → near-total stall).
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
