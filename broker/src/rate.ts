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

  /** Block until one token is available (and any 429 penalty has elapsed). */
  acquire(): Promise<void> {
    const next = this.chain.then(() => this.consumeOne());
    this.chain = next.catch(() => undefined); // never poison the queue
    return next;
  }

  /** Freeze the bucket until `epochMs` (absolute) — called on upstream 429. */
  penalizeUntil(epochMs: number): void {
    if (epochMs > this.pausedUntilEpochMs) this.pausedUntilEpochMs = epochMs;
  }

  private async consumeOne(): Promise<void> {
    const penaltyMs = this.pausedUntilEpochMs - Date.now();
    if (penaltyMs > 0) await sleep(penaltyMs);

    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const deficit = 1 - this.tokens;
    await sleep((deficit / this.rps) * 1000);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
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
 * Parse a BnF `Retry-After` header into an absolute epoch-ms deadline. BnF sends
 * an absolute HTTP-date in GMT (NOT delta-seconds), e.g.
 * "Wed, 26 Apr 2026 15:31:00 GMT". Falls back to delta-seconds if a bare integer
 * is sent, and to `fallbackMs` from now when unparseable.
 */
export function retryAfterToEpochMs(header: string | undefined, fallbackMs: number): number {
  const now = Date.now();
  if (!header) return now + fallbackMs;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000; // delta-seconds
  const t = Date.parse(trimmed); // HTTP-date (GMT) → epoch-ms
  return Number.isFinite(t) && t > now ? t : now + fallbackMs;
}
