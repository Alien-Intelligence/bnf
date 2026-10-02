// lib/async/deadline.ts
// Bound an await that takes no signal of its own (a Prisma query, a lock) by a
// wall-clock deadline and, optionally, a caller's AbortSignal
// (CLAUDE_ERROR_PATTERNS §14: every external-resource await has a timeout).
// The underlying work is not cancelled — the caller stops waiting for it and
// gets a typed, loud failure instead of a hang.

/** The deadline passed, or the caller's signal aborted, before the work settled. */
export class DeadlineExceededError extends Error {
  constructor(label: string, reason: "timeout" | "aborted", ms: number) {
    super(
      reason === "timeout"
        ? `${label}: no answer within ${ms} ms`
        : `${label}: aborted before it settled`,
    )
    this.name = "DeadlineExceededError"
  }
}

export function withDeadline<T>(
  work: Promise<T>,
  opts: { label: string; ms: number; signal?: AbortSignal },
): Promise<T> {
  const { label, ms, signal } = opts
  if (signal?.aborted) return Promise.reject(new DeadlineExceededError(label, "aborted", ms))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new DeadlineExceededError(label, "timeout", ms))
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new DeadlineExceededError(label, "aborted", ms))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err: unknown) => {
        cleanup()
        reject(err)
      },
    )
  })
}
