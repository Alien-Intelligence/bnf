/**
 * Minimal async semaphore — bounds how many async operations run at once. Used to
 * parallelize a doc's per-folio work (e.g. vision describe calls) WITHOUT letting
 * the total in-flight count blow past what the downstream provider tolerates
 * (OpenRouter's Cloudflare DDoS / rate limits). One shared instance caps ALL
 * concurrent calls across every doc in the stage, so a single big doc can use the
 * full width while many docs still share the same ceiling.
 *
 * Distinct from RateLimiter (a token bucket pacing requests/min): a semaphore
 * caps CONCURRENCY (simultaneous in-flight), not rate.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore: max must be a positive integer, got ${max}`);
    }
  }

  /** Run `fn` once a slot is free; always releases the slot, even on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter (inFlight stays at max).
      next();
    } else {
      this.inFlight--;
    }
  }
}
