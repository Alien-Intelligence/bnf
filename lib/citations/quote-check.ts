/**
 * lib/citations/quote-check.ts
 *
 * Server-only orchestrator of the quote check: extracts the quotes of a note
 * body, fetches the text of every cited document through the cluster facade,
 * runs the pure matcher, and returns non-blocking warnings for the agent.
 *
 * Bounds (CLAUDE_ERROR_PATTERNS §14): at most QUOTE_CHECK_MAX_SOURCES distinct
 * ARKs per write, QUOTE_CHECK_CONCURRENCY fetches in flight, and one overall
 * budget (`budgetMs`, QUOTE_CHECK_BUDGET_MS in production), on ONE monotonic
 * clock (`performance.now()`): the same start drives the abort signal
 * composed into the caller's for every await on the cluster, and the
 * deadline ticked inside every synchronous loop — the body scan
 * (quotes.ts), tokenisation and alignment (quote-match.ts) — so neither a
 * slow cluster nor a dense body or long quote runs past it. Whatever is left
 * when it passes is `unverifiable / budget_exceeded` (or `cancelled`), with
 * the reason carried by the error that stopped it, never a default.
 *
 * Errors, classified by which signal fired, never by an error's name:
 *   - the caller's signal (the turn was cancelled) → that ARK's quotes are
 *     `unverifiable / cancelled`;
 *   - the budget → `unverifiable / budget_exceeded`;
 *   - neither, but an entry whose folio boundaries cannot be trusted
 *     (`FolioMapAmbiguousError`: an older entry with no page offsets whose
 *     headings are out of order or whose prefix is not the documented one) →
 *     `unverifiable / folio_map_ambiguous`, plus a `console.warn`;
 *   - neither, but a typed cluster error (`DataclusterMcpError`) →
 *     `unverifiable / lookup_failed`, plus a `console.warn`;
 *   - anything else (a bug, a database failure in the quality lookup, an
 *     abort neither signal caused) is unexpected: it aborts the sibling
 *     fetches and propagates — the tool layer turns it into
 *     `quote_check.status: "failed"` after the write (plan D5).
 *
 * Honesty about what was checked: a caller without a per-folio quality index
 * passes `lowOcrFolios: null`, and `correction_on_low_ocr` cannot be evaluated.
 * The result then lists it in `unevaluated_rules` and is `partial`, never
 * `complete`. The note tools pass Track B's stored folio quality
 * (lib/agent/tools/note.ts lowOcrFoliosOf).
 */
import "server-only"

import { QUOTE_CHECK_CONCURRENCY, QUOTE_CHECK_MAX_SOURCES, QUOTE_MIN_CHECKED_WORDS, QUOTE_WARNING_EXCERPT_CHARS, OCR_CORRECTION_MARKING } from "@/lib/constants"
import { QUOTE_WARNING_DETAIL } from "@/lib/agent/prompts/quote-warnings"
import { DataclusterMcpError } from "@/lib/cluster/datacluster-mcp-client"
import { raceAbort } from "@/lib/mcp/abort"
import { ClusterRagClient, RAG_LOOKUP_STATUS } from "@/lib/cluster/rag"
import { FolioMapAmbiguousError, type DocumentFolios } from "@/lib/cluster/folio-text"
import {
  QUOTE_CHECK_STATUS,
  QUOTE_UNVERIFIABLE_CAUSE,
  QUOTE_WARNING_REASON,
  type QuoteCheckResult,
  type QuoteCitation,
  type QuoteUnverifiableCause,
  type QuoteWarning,
  type QuoteWarningReason,
} from "@/models/notes/schema"
import { QuoteMatchDeadlineError, type OutOfTime } from "./deadline"
import { quoteIdentity, scanNoteQuotes } from "./quotes"
import type { ExtractedQuote, QuoteScan } from "./quotes"
import { tokenizeFolios, verifyQuote } from "./quote-match"
import type { SourceDocument } from "./quote-match"

/**
 * Per-folio OCR quality: which of the cited folios of a document are poorly
 * recognised (plan D9). The implementation is the per-(ark, folio) quality
 * index Track B builds for its note banner (`loadFolioIndex` in
 * lib/agent/tools/rag-ocr.ts, over `DocumentQueries.ocrForRefs`); this module
 * does not build a second one. A database failure inside it propagates.
 */
export type LowOcrFoliosLookup = (args: {
  corpusProjectId: string
  ark: string
  folios: ReadonlySet<number>
}) => Promise<ReadonlySet<number>>

export type CheckNoteQuotesArgs = {
  corpusProjectId: string
  /** The text whose quotes are in scope (see the tool wiring in note.ts). */
  bodyMd: string
  /** Quotes already here with the same text, marks and citation are skipped — they were not written this turn. */
  priorBodyMd: string | null
  signal: AbortSignal
  /**
   * The per-folio quality lookup, or `null` when none exists in this build:
   * an explicit decision, reported as `unevaluated_rules`, never a silent
   * empty set.
   */
  lowOcrFolios: LowOcrFoliosLookup | null
  /** Ceiling of the whole check, on the monotonic clock (QUOTE_CHECK_BUDGET_MS in production). */
  budgetMs: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight; results keep order. */
async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

function warning(
  quote: string,
  citation: QuoteCitation | null,
  reason: QuoteWarningReason,
  extra: { cause?: QuoteUnverifiableCause; found_on_folio?: number } = {},
): QuoteWarning {
  return {
    quote: quote.slice(0, QUOTE_WARNING_EXCERPT_CHARS),
    citation,
    reason,
    ...extra,
    detail: QUOTE_WARNING_DETAIL[reason],
  }
}

function unverifiable(q: ExtractedQuote, cause: QuoteUnverifiableCause): QuoteWarning {
  return warning(q.raw, q.citation, QUOTE_WARNING_REASON.UNVERIFIABLE, { cause })
}

type FetchOutcome =
  | { kind: "found"; folios: DocumentFolios; low: ReadonlySet<number> | null }
  | { kind: "unverifiable"; cause: QuoteUnverifiableCause }

/** The signals one check runs under, so a failure can be traced to its cause. */
type CheckSignals = {
  /** The caller's: the turn. */
  caller: AbortSignal
  /** The check's own budget. */
  budget: AbortSignal
  /** Aborted when one fetch fails unexpectedly, to stop its siblings. */
  siblings: AbortController
  /** All three composed: what every await is bound to. */
  any: AbortSignal
}

/**
 * Fetch one cited document and the quality of its cited folios, and classify
 * any failure by which signal fired (see the module header).
 */
async function fetchDocument(
  args: CheckNoteQuotesArgs,
  ark: string,
  citedFolios: ReadonlySet<number>,
  signals: CheckSignals,
): Promise<FetchOutcome> {
  try {
    const result = await raceAbort(
      ClusterRagClient.getDocumentFolios({ projectId: args.corpusProjectId, ark, signal: signals.any }),
      signals.any,
    )
    if (result.status === RAG_LOOKUP_STATUS.ENTRY_NOT_FOUND) {
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.ENTRY_NOT_FOUND }
    }
    const low = args.lowOcrFolios
      ? await raceAbort(args.lowOcrFolios({ corpusProjectId: args.corpusProjectId, ark, folios: citedFolios }), signals.any)
      : null
    return { kind: "found", folios: result.folios, low }
  } catch (err) {
    if (signals.caller.aborted) {
      console.warn(`[quote check] ${ark}: unverifiable, the turn was cancelled`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.CANCELLED }
    }
    if (signals.budget.aborted) {
      console.warn(`[quote check] ${ark}: unverifiable, the ${args.budgetMs} ms budget ran out`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED }
    }
    if (signals.siblings.signal.aborted) throw err
    if (err instanceof FolioMapAmbiguousError) {
      console.warn(`[quote check] ${ark}: unverifiable, folio map ambiguous — ${err.message}`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.FOLIO_MAP_AMBIGUOUS }
    }
    if (err instanceof DataclusterMcpError) {
      console.warn(`[quote check] ${ark}: unverifiable, lookup failed — ${err.message}`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.LOOKUP_FAILED }
    }
    signals.siblings.abort(err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the quotes of `bodyMd` against the folios they cite. Never blocks a
 * write and never throws for a mismatch; see the module header for what does
 * propagate.
 */
export async function checkNoteQuotes(args: CheckNoteQuotesArgs): Promise<QuoteCheckResult> {
  if (!Number.isSafeInteger(args.budgetMs) || args.budgetMs <= 0) {
    // A caller bug, not a quote problem: NaN would disable the deadline and
    // abort every fetch at once.
    throw new RangeError(`checkNoteQuotes: budgetMs must be a positive integer, got ${args.budgetMs}`)
  }
  const budget = monotonicBudget(args.budgetMs)
  const outOfTime: OutOfTime = () =>
    args.signal.aborted
      ? QUOTE_UNVERIFIABLE_CAUSE.CANCELLED
      : budget.expired()
        ? QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED
        : null
  try {
    return await runCheck(args, budget.signal, outOfTime)
  } finally {
    budget.dispose()
  }
}

/**
 * The check's budget on the monotonic clock: `expired()` for the synchronous
 * loops and `signal` for the awaits, both from the same start, so they can
 * never disagree about whether the budget is spent.
 */
function monotonicBudget(budgetMs: number): { signal: AbortSignal; expired: () => boolean; dispose: () => void } {
  const deadline = performance.now() + budgetMs
  const controller = new AbortController()
  const expire = () => controller.abort(new DOMException(`the ${budgetMs} ms quote-check budget ran out`, "TimeoutError"))
  // setTimeout may fire a hair early or late; re-arm until the clock agrees.
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    const left = deadline - performance.now()
    if (left <= 0) expire()
    else timer = setTimeout(arm, Math.ceil(left))
  }
  arm()
  return {
    signal: controller.signal,
    expired: () => {
      if (controller.signal.aborted) return true
      if (performance.now() < deadline) return false
      expire()
      return true
    },
    dispose: () => clearTimeout(timer),
  }
}

async function runCheck(args: CheckNoteQuotesArgs, budget: AbortSignal, outOfTime: OutOfTime): Promise<QuoteCheckResult> {
  const scanOptions = { outOfTime, excerptChars: QUOTE_WARNING_EXCERPT_CHARS }
  const body = scanNoteQuotes(args.bodyMd, scanOptions)
  const prior: QuoteScan | null = args.priorBodyMd === null ? null : scanNoteQuotes(args.priorBodyMd, scanOptions)
  const priorQuotes = new Set(prior?.quotes.map(quoteIdentity))
  const quotes = body.quotes.filter((q) => q.words >= QUOTE_MIN_CHECKED_WORDS && !priorQuotes.has(quoteIdentity(q)))
  const warnings: Array<{ index: number; w: QuoteWarning }> = []
  const push = (index: number, w: QuoteWarning) => warnings.push({ index, w })

  // An opening mark never closed: the text after it cannot be delimited. A
  // block given up past the stray-mark cap: its rest was not looked at. Both
  // are skipped when the prior body already had them (not written this turn).
  const priorUnbalanced = new Set(prior?.unbalanced.map((u) => u.excerpt))
  for (const u of body.unbalanced) {
    if (priorUnbalanced.has(u.excerpt)) continue
    push(u.index, warning(u.excerpt, null, QUOTE_WARNING_REASON.UNBALANCED_QUOTE_MARK))
  }
  const priorUnscanned = new Set(prior?.unscannedRestOfBlock.map((u) => u.excerpt))
  for (const u of body.unscannedRestOfBlock) {
    if (priorUnscanned.has(u.excerpt)) continue
    push(u.index, warning(u.excerpt, null, QUOTE_WARNING_REASON.UNSCANNED_REST_OF_BLOCK))
  }
  // The deadline stopped the scan itself: the rest of the body is unchecked.
  if (body.stopped !== null) {
    push(body.stopped.index, warning(body.stopped.excerpt, null, QUOTE_WARNING_REASON.UNVERIFIABLE, { cause: body.stopped.reason }))
  }

  const byArk = new Map<string, Array<{ q: ExtractedQuote; citation: QuoteCitation }>>()
  for (const q of quotes) {
    if (q.citation === null) {
      push(q.index, warning(q.raw, null, QUOTE_WARNING_REASON.UNCITED))
      continue
    }
    const list = byArk.get(q.citation.ark)
    if (list) list.push({ q, citation: q.citation })
    else byArk.set(q.citation.ark, [{ q, citation: q.citation }])
  }

  const groups = [...byArk.entries()]
  for (const [, list] of groups.slice(QUOTE_CHECK_MAX_SOURCES)) {
    for (const { q } of list) push(q.index, unverifiable(q, QUOTE_UNVERIFIABLE_CAUSE.TOO_MANY_SOURCES))
  }

  const fetched = groups.slice(0, QUOTE_CHECK_MAX_SOURCES)
  // The scan is bounded by the same deadline: if it used the budget up,
  // nothing is fetched and every grouped quote is reported as stopped.
  const stoppedEarly = outOfTime()
  if (stoppedEarly !== null) {
    for (const [, list] of fetched) for (const { q } of list) push(q.index, unverifiable(q, stoppedEarly))
  } else if (fetched.length > 0) {
    const siblings = new AbortController()
    const signals: CheckSignals = {
      caller: args.signal,
      budget,
      siblings,
      any: AbortSignal.any([args.signal, budget, siblings.signal]),
    }
    const outcomes = await mapConcurrent(fetched, QUOTE_CHECK_CONCURRENCY, ([ark, list]) =>
      fetchDocument(args, ark, new Set(list.map((x) => x.citation.folio)), signals),
    )

    for (const [i, [, list]] of fetched.entries()) {
      const outcome = outcomes[i]
      if (outcome.kind === "unverifiable") {
        for (const { q } of list) push(q.index, unverifiable(q, outcome.cause))
        continue
      }
      for (const w of verifyDocument(list, outcome, outOfTime)) push(w.index, w.w)
    }
  }

  const unevaluated: QuoteWarningReason[] =
    args.lowOcrFolios === null && quotes.length > 0 ? [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR] : []
  const ordered = warnings.sort((a, b) => a.index - b.index).map((x) => x.w)
  // A quote that could not be checked — unverifiable, or behind an unclosed
  // mark — means the result does not cover the whole body.
  const partial =
    unevaluated.length > 0 ||
    ordered.some((w) => PARTIAL_REASONS.has(w.reason))
  return {
    status: partial ? QUOTE_CHECK_STATUS.PARTIAL : QUOTE_CHECK_STATUS.COMPLETE,
    checked: quotes.length,
    warnings: ordered,
    unevaluated_rules: unevaluated,
  }
}

/** Reasons that mean part of the body was not checked: the result is `partial`. */
const PARTIAL_REASONS: ReadonlySet<QuoteWarningReason> = new Set([
  QUOTE_WARNING_REASON.UNVERIFIABLE,
  QUOTE_WARNING_REASON.UNBALANCED_QUOTE_MARK,
  QUOTE_WARNING_REASON.UNSCANNED_REST_OF_BLOCK,
])

/**
 * Match one fetched document's quotes. The deadline is checked before the
 * document is tokenised, before each quote, and inside the matcher; whatever
 * is left when it passes is `unverifiable` with the cause.
 */
function verifyDocument(
  list: ReadonlyArray<{ q: ExtractedQuote; citation: QuoteCitation }>,
  outcome: Extract<FetchOutcome, { kind: "found" }>,
  outOfTime: OutOfTime,
): Array<{ index: number; w: QuoteWarning }> {
  const out: Array<{ index: number; w: QuoteWarning }> = []
  const stopAll = (from: number, cause: QuoteUnverifiableCause) => {
    for (const { q } of list.slice(from)) out.push({ index: q.index, w: unverifiable(q, cause) })
  }
  let doc: SourceDocument
  try {
    doc = tokenizeFolios(outcome.folios, outOfTime)
  } catch (err) {
    if (!(err instanceof QuoteMatchDeadlineError)) throw err
    stopAll(0, err.reason)
    return out
  }
  for (const [n, { q, citation }] of list.entries()) {
    const late = outOfTime()
    if (late !== null) {
      stopAll(n, late)
      return out
    }
    if (!outcome.folios.has(citation.folio)) {
      out.push({ index: q.index, w: unverifiable(q, QUOTE_UNVERIFIABLE_CAUSE.FOLIO_ABSENT) })
      continue
    }
    let verdicts
    try {
      verdicts = verifyQuote(q, doc, {
        outOfTime,
        citedFolio: citation.folio,
        marking: OCR_CORRECTION_MARKING,
        lowOcrFolios: outcome.low,
      })
    } catch (err) {
      if (!(err instanceof QuoteMatchDeadlineError)) throw err
      stopAll(n, err.reason)
      return out
    }
    for (const v of verdicts) {
      if (v.ok) continue
      out.push({
        index: q.index,
        w: warning(q.raw, citation, v.reason, v.foundOnFolio === undefined ? {} : { found_on_folio: v.foundOnFolio }),
      })
    }
  }
  return out
}
