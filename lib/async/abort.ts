// lib/async/abort.ts
// Telling a caller's OWN abort from a failure of the thing it was waiting on,
// shared by the background drainers (lib/buffer/enricher.ts,
// lib/documents/resolver.ts). Pure: imports nothing.

/** How deep `causedByOwnCeiling` follows an error's `cause` chain. */
const MAX_CAUSE_DEPTH = 5

/**
 * True when `error` IS the caller's own abort — the signal's reason, or an
 * AbortError — directly or through its `cause` chain. Classified by CAUSE, not
 * by the signal's state: a 404 that happens to land after the ceiling fired is
 * still the remote's answer, and counts.
 */
export function causedByOwnCeiling(error: unknown, signal: AbortSignal): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (signal.aborted && current === signal.reason) return true
    if (current instanceof Error && current.name === "AbortError") return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}
