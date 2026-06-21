/**
 * Exponential-backoff retry helper for Gallica HTTP calls.
 *
 *   - 4 attempts by default
 *   - exponential 2^n * baseMs + jitter (±25% of baseMs, capped 250 ms)
 *   - per-delay cap 30 s, total wall-clock budget 60 s
 *   - PermanentBnfError is rethrown immediately
 *   - 429 responses get a longer base delay (5 s)
 *
 * The helper never sleeps past the budget — the last attempt fires immediately
 * once we'd otherwise exceed it. Callers should still expect total wait-time
 * up to roughly opts.totalBudgetMs.
 */
import { PermanentBnfError, TransientBnfError } from "./errors.js";

export interface RetryOptions {
  /** Max attempts (including the first). Default 4. */
  attempts?: number;
  /** Base delay in ms for the exponential schedule. Default 500. */
  baseMs?: number;
  /** Per-delay ceiling in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Total wall-clock budget across all attempts. Default 60_000. */
  totalBudgetMs?: number;
  /** Optional label used in log lines. */
  label?: string;
}

const JITTER_MS = 250;

function pickDelay(
  attempt: number,
  baseMs: number,
  maxDelayMs: number,
  is429: boolean,
): number {
  const effectiveBase = is429 ? Math.max(baseMs, 5000) : baseMs;
  const exp = effectiveBase * Math.pow(2, attempt);
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.min(maxDelayMs, Math.max(0, exp + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withBnfRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const totalBudgetMs = opts.totalBudgetMs ?? 60_000;
  const label = opts.label ?? "bnf-api";

  const start = Date.now();
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (err instanceof PermanentBnfError) {
        throw err;
      }

      const isLast = i === attempts - 1;
      if (isLast) break;

      const is429 = err instanceof TransientBnfError && err.is429;
      const delay = pickDelay(i, baseMs, maxDelayMs, is429);
      const elapsed = Date.now() - start;
      if (elapsed + delay > totalBudgetMs) {
        // Out of budget — give up retrying and rethrow the last error.
        break;
      }

      console.warn(
        `[retry:${label}] attempt ${i + 1}/${attempts} failed (${
          err instanceof Error ? err.message : String(err)
        }), sleeping ${Math.round(delay)} ms`,
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}
