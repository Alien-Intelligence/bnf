/**
 * Process-wide token-bucket rate limiter for Gallica HTTP calls.
 *
 * Why this exists
 * ---------------
 * Pass 2's per-call exponential backoff handled bursts within a single
 * document, but the worker fans out across many documents in parallel and
 * each ARK opens its own ALTO loop. Gallica's RequestDigitalElement
 * endpoint throws ECONNRESET storms when aggregate traffic crosses a few
 * requests per second — the per-call retry can't see what other docs are
 * doing, so they all hammer in lock-step.
 *
 * This module is the single chokepoint that every outbound Gallica HTTP
 * call must `acquire()` from before sending. Because it's a module-level
 * singleton, every concurrent doc-job in this worker process shares the
 * same budget. (Multi-process / multi-worker coordination would need
 * Redis or pg — out of scope; we run one worker.)
 *
 * Algorithm
 * ---------
 * Classic token bucket:
 *   - Capacity: `burst` tokens. Refilled at `rps` tokens per second.
 *   - On acquire(): refill based on elapsed monotonic time, then either
 *     consume 1 token immediately if available, or compute the wait time
 *     until the next token, sleep for it, and consume.
 *   - Acquirers serialize via a FIFO promise chain so that under
 *     contention they pick up tokens in arrival order rather than racing.
 *
 * Monotonic time via performance.now() — wall-clock jumps would otherwise
 * either stall (clock jumps back) or burst-release (clock jumps forward).
 */

export interface TokenBucketOptions {
  /** Steady-state requests per second. */
  rps: number;
  /** Maximum tokens that can accumulate (the "burst" headroom). */
  burst: number;
}

class TokenBucket {
  private readonly rps: number;
  private readonly burst: number;
  private tokens: number;
  private lastRefill: number;
  /** FIFO chain — each acquire() awaits the previous one's wait completion. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.rps) || opts.rps <= 0) {
      throw new Error(`TokenBucket: rps must be > 0, got ${opts.rps}`);
    }
    if (!Number.isFinite(opts.burst) || opts.burst < 1) {
      throw new Error(`TokenBucket: burst must be >= 1, got ${opts.burst}`);
    }
    this.rps = opts.rps;
    this.burst = opts.burst;
    this.tokens = opts.burst;
    this.lastRefill = performance.now();
  }

  /** Block until one token is available, then consume it. */
  acquire(): Promise<void> {
    const next = this.chain.then(() => this.consumeOne());
    // Don't propagate a rejection through the chain — consumeOne never
    // throws, but be defensive so a buggy refactor can't poison the queue.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async consumeOne(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for enough time to accrue exactly one token.
    const deficit = 1 - this.tokens;
    const waitMs = (deficit / this.rps) * 1000;
    await sleep(waitMs);
    this.refill();
    // After refill we MUST have at least 1; clamp defensively.
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

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid ${name}=${raw}: must be a positive number (got NaN/<=0).`,
    );
  }
  return n;
}

/**
 * STRICT limiter — only for the ALTO endpoint (RequestDigitalElement?E=ALTO),
 * which is empirically capped at ~5 req/min. ALTO is now the fallback OCR path
 * (the viewer scrape is primary), so this rarely fires, but when it does it
 * must stay under the documented quota. Default 0.083 rps = 5/min.
 */
export const altoRateLimit = new TokenBucket({
  rps: readPositiveNumber("GALLICA_RPS", 0.083),
  burst: readPositiveNumber("GALLICA_BURST", 5),
});

/**
 * GENERAL limiter — for every other Gallica call (OAIRecord, Pagination,
 * manifest, IIIF image fetch). These are NOT under the ALTO quota; throttling
 * them at 5/min was a hidden serializer that made a 10-doc batch take minutes
 * just for metadata. A generous bucket keeps us polite without crippling
 * throughput. Default 8 rps, burst 16 — tune via GALLICA_GENERAL_RPS/BURST.
 */
export const gallicaRateLimit = new TokenBucket({
  rps: readPositiveNumber("GALLICA_GENERAL_RPS", 8),
  burst: readPositiveNumber("GALLICA_GENERAL_BURST", 16),
});

/** Exported for tests only. */
export { TokenBucket };
