// lib/mcp/abort.ts
// Combine a caller-supplied AbortSignal with a wall-clock timeout so every MCP
// HTTP await is bounded (CLAUDE_ERROR_PATTERNS §14 — no unbounded awaits).
// Pure utility — no secrets, no transport. Used by lib/mcp/session.ts and
// lib/bnf/direct.ts.

/**
 * Return an AbortSignal that fires when EITHER `signal` aborts (turn cancelled)
 * OR `timeoutMs` elapses (stalled transport). When no `signal` is supplied
 * (e.g. the seed script), the returned signal is the timeout alone — the await
 * is still bounded.
 *
 * Call this per HTTP attempt (not once per logical operation) so each retry
 * gets a fresh deadline rather than sharing one budget across all attempts.
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Resolve with `p`, or reject with the signal's reason the moment it aborts.
 * For awaits that cannot take a signal themselves (a Prisma query, an
 * injected lookup): the caller stops waiting at once; the abandoned promise
 * settles on its own and its rejection is handled here, never unhandled.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}
