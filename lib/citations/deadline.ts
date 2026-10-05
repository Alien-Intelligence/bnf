/**
 * lib/citations/deadline.ts
 *
 * The stop condition shared by the quote extractor (quotes.ts), the matcher
 * (quote-match.ts) and the orchestrator (quote-check.ts). Pure — no
 * server-only imports — so the e2e harness and the tests run the same code.
 *
 * The extraction, tokenisation and alignment of a long body or document are
 * synchronous: a deadline can only bound them if it is checked INSIDE their
 * loops. Each loop counts its steps with a `StopCheck` and asks the clock once
 * every QUOTE_MATCH_DEADLINE_STRIDE steps, so the check is cheap and the
 * overrun is at most one stride of work.
 */

import { QUOTE_MATCH_DEADLINE_STRIDE } from "@/lib/constants"
import { QUOTE_UNVERIFIABLE_CAUSE } from "@/models/notes/schema"

/** Why the work had to stop: the turn was cancelled, or the check's budget ran out. */
export type StopReason = typeof QUOTE_UNVERIFIABLE_CAUSE.CANCELLED | typeof QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED

/** The reason the work must stop now, or null while it may go on. */
export type OutOfTime = () => StopReason | null

/** For offline tools and tests that run without a budget. */
export const neverOutOfTime: OutOfTime = () => null

/**
 * Thrown from inside synchronous work when `OutOfTime` says stop. It carries
 * the reason, so the caller reports exactly why — never a guessed default.
 */
export class QuoteMatchDeadlineError extends Error {
  constructor(readonly reason: StopReason) {
    super(`quote matching stopped: ${reason}`)
    this.name = "QuoteMatchDeadlineError"
  }
}

/** Throws QuoteMatchDeadlineError when `outOfTime` says stop. */
export function stopIfOutOfTime(outOfTime: OutOfTime): void {
  const reason = outOfTime()
  if (reason !== null) throw new QuoteMatchDeadlineError(reason)
}

/**
 * A step counter for one loop: `tick()` asks the clock on the first step and
 * then every QUOTE_MATCH_DEADLINE_STRIDE steps, and throws when it says stop.
 */
export class StopCheck {
  private steps = 0

  constructor(private readonly outOfTime: OutOfTime) {}

  tick(): void {
    if (this.steps++ % QUOTE_MATCH_DEADLINE_STRIDE === 0) stopIfOutOfTime(this.outOfTime)
  }
}
