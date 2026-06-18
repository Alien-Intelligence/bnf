// lib/mcp/retry.ts
// Exponential-backoff retry + bounded-concurrency helpers for BnF MCP calls.
// No external dependencies — plain async/await only.

import { BnfMcpAuthError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "./errors"
import {
  BNF_MCP_RETRY_ATTEMPTS,
  BNF_MCP_RETRY_BASE_MS,
  BNF_MCP_RETRY_CAP_MS,
} from "@/lib/constants"

/** ±20% uniform jitter applied to each retry delay. */
const JITTER_FACTOR = 0.2

function applyJitter(ms: number): number {
  const delta = ms * JITTER_FACTOR
  return ms + (Math.random() * 2 - 1) * delta
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  /** Total call attempts (first try + retries). Default: BNF_MCP_RETRY_ATTEMPTS (3). */
  attempts?: number
  /** Base delay in ms before the first retry. Default: BNF_MCP_RETRY_BASE_MS (500). */
  baseMs?: number
  /** Maximum delay cap in ms. Default: BNF_MCP_RETRY_CAP_MS (8000). */
  capMs?: number
}

/**
 * Runs `fn` with exponential backoff over `attempts` total tries.
 *
 * Terminal errors (no retry):
 *   - BnfMcpAuthError (401/403)
 *   - BnfMcpNotFoundError (404)
 *
 * BnfMcpRateLimitError honours `retryAfterMs` when present, otherwise falls
 * back to the computed exponential delay.
 *
 * Delay formula: min(baseMs * 2^attempt + jitter(±20%), capMs)
 * where `attempt` is 0-indexed (so first retry uses baseMs * 2^0 = baseMs).
 *
 * Re-throws the last error after exhausting all attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.attempts ?? BNF_MCP_RETRY_ATTEMPTS
  const baseMs = opts.baseMs ?? BNF_MCP_RETRY_BASE_MS
  const capMs = opts.capMs ?? BNF_MCP_RETRY_CAP_MS

  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Terminal — never retry these.
      if (err instanceof BnfMcpAuthError || err instanceof BnfMcpNotFoundError) {
        throw err
      }

      const isLastAttempt = attempt === maxAttempts - 1
      if (isLastAttempt) break

      // Compute delay: honour Retry-After header for rate-limit errors.
      let waitMs: number
      if (err instanceof BnfMcpRateLimitError && err.retryAfterMs !== undefined) {
        waitMs = err.retryAfterMs
      } else {
        const exponential = baseMs * Math.pow(2, attempt)
        waitMs = applyJitter(Math.min(exponential, capMs))
      }

      await delay(waitMs)
    }
  }

  throw lastError
}

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

/** Result of a single `withConcurrency` worker invocation. */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

/**
 * Runs `worker` over all `inputs` with at most `concurrency` in-flight
 * Promises at any time.
 *
 * Returns results in **input order** (not resolution order) regardless of how
 * quickly individual workers complete. Callers can correlate `results[i]`
 * with `inputs[i]` safely.
 *
 * All workers run to completion: individual failures are captured as
 * `{ ok: false; error }` entries rather than rejecting the whole batch.
 */
export async function withConcurrency<I, T>(
  inputs: I[],
  worker: (input: I) => Promise<T>,
  concurrency: number,
): Promise<Settled<T>[]> {
  const results: Settled<T>[] = new Array(inputs.length)
  let nextIndex = 0

  async function runSlot(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= inputs.length) break

      try {
        results[index] = { ok: true, value: await worker(inputs[index]) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }

  // Spin up `concurrency` slots (or fewer if inputs is smaller).
  const slots = Math.min(concurrency, inputs.length)
  await Promise.all(Array.from({ length: slots }, runSlot))

  return results
}
