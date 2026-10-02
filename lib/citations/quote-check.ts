/**
 * lib/citations/quote-check.ts
 *
 * Server-only orchestrator of the quote check: extracts the quotes of a note
 * body, fetches the text of every cited document through the cluster facade,
 * runs the pure matcher, and returns non-blocking warnings for the agent.
 *
 * Bounds (CLAUDE_ERROR_PATTERNS §14): at most QUOTE_CHECK_MAX_SOURCES distinct
 * ARKs per write, QUOTE_CHECK_CONCURRENCY fetches in flight, and one overall
 * QUOTE_CHECK_BUDGET_MS budget composed into the caller's signal. Every await
 * on the cluster is raced against that signal, so a callee that ignores it
 * cannot hold the write hostage.
 *
 * Errors: an expected cluster failure (`DataclusterMcpError`) or the budget
 * running out makes THAT ARK's quotes `unverifiable` with a cause, plus a
 * `console.warn`. Anything else is unexpected and propagates — the tool layer
 * turns it into `quote_check.status: "failed"` after the write (plan D5).
 */
import "server-only"

import {
  OCR_CORRECTION_MARKING,
  QUOTE_CHECK_BUDGET_MS,
  QUOTE_CHECK_CONCURRENCY,
  QUOTE_CHECK_MAX_SOURCES,
  QUOTE_MIN_CHECKED_WORDS,
  QUOTE_WARNING_EXCERPT_CHARS,
} from "@/lib/constants"
import { DataclusterMcpError } from "@/lib/cluster/datacluster-mcp-client"
import { ClusterRagClient } from "@/lib/cluster/rag"
import type { DocumentFolios } from "@/lib/cluster/folio-text"
import {
  QUOTE_UNVERIFIABLE_CAUSE,
  QUOTE_WARNING_DETAIL,
  QUOTE_WARNING_REASON,
  type QuoteUnverifiableCause,
  type QuoteWarningReason,
} from "@/models/notes/schema"
import { extractQuotes, isSameQuote } from "./quotes"
import type { ExtractedQuote } from "./quotes"
import { tokenizeFolios, verifyQuote } from "./quote-match"
import type { SourceToken } from "./quote-match"

export type QuoteWarning = {
  /** First QUOTE_WARNING_EXCERPT_CHARS characters of the quote, as written. */
  quote: string
  citation: { ark: string; folio: number } | null
  reason: QuoteWarningReason
  /** Only for `unverifiable`. */
  cause?: QuoteUnverifiableCause
  found_on_folio?: number
  /** QUOTE_WARNING_DETAIL[reason] — what the agent should do. */
  detail: string
}

export type QuoteCheckResult = {
  /** `partial` when any quote is `unverifiable`; `failed` is set by the tool layer. */
  status: "complete" | "partial" | "failed"
  /** Quotes that were in scope (long enough, not already in the prior body). */
  checked: number
  warnings: QuoteWarning[]
}

/**
 * Per-folio OCR quality: which of the cited folios of a document are poorly
 * recognised (plan D9). The implementation is the per-(ark, folio) quality
 * index Track B builds for its note banner (`loadFolioIndex` in
 * lib/agent/tools/rag-ocr.ts, over `DocumentQueries.ocrForRefs`); this module
 * does not build a second one. That index does not exist on this branch yet,
 * so the note tools do not pass a lookup and `correction_on_low_ocr` cannot
 * fire in production until it is wired at the rebase onto Track B. A DB
 * failure inside the lookup is not a cluster error: it propagates.
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
  lowOcrFolios?: LowOcrFoliosLookup
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_LOW_FOLIOS: ReadonlySet<number> = new Set()

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}

/** Resolve with `p`, or reject with the signal's reason the moment it aborts. */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
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
  q: ExtractedQuote,
  reason: QuoteWarningReason,
  extra: { cause?: QuoteUnverifiableCause; found_on_folio?: number } = {},
): QuoteWarning {
  return {
    quote: q.raw.slice(0, QUOTE_WARNING_EXCERPT_CHARS),
    citation: q.citation,
    reason,
    ...extra,
    detail: QUOTE_WARNING_DETAIL[reason],
  }
}

function unverifiable(q: ExtractedQuote, cause: QuoteUnverifiableCause): QuoteWarning {
  return warning(q, QUOTE_WARNING_REASON.UNVERIFIABLE, { cause })
}

type FetchOutcome =
  | { kind: "found"; folios: DocumentFolios; doc: SourceToken[]; low: ReadonlySet<number> }
  | { kind: "unverifiable"; cause: QuoteUnverifiableCause }

/** Why the check stopped waiting: its own budget, or the turn being cancelled. */
function abortCause(callerSignal: AbortSignal): string {
  return callerSignal.aborted ? "the turn was cancelled" : `the ${QUOTE_CHECK_BUDGET_MS} ms budget ran out`
}

/**
 * Fetch one cited document and the quality of its cited folios. Both awaits
 * share one classification: an abort (budget or turn) or an expected cluster
 * failure makes THIS ARK unverifiable; anything else — a bug, a DB failure in
 * the quality lookup — propagates.
 */
async function fetchDocument(
  args: CheckNoteQuotesArgs,
  ark: string,
  citedFolios: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  try {
    const result = await raced(
      ClusterRagClient.getDocumentFolios({ projectId: args.corpusProjectId, ark, signal }),
      signal,
    )
    if (result.status === "entry_not_found") {
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.ENTRY_NOT_FOUND }
    }
    const low = args.lowOcrFolios
      ? await raced(args.lowOcrFolios({ corpusProjectId: args.corpusProjectId, ark, folios: citedFolios }), signal)
      : NO_LOW_FOLIOS
    return { kind: "found", folios: result.folios, doc: tokenizeFolios(result.folios), low }
  } catch (err) {
    if (isAbort(err)) {
      console.warn(`[quote check] ${ark}: unverifiable, ${abortCause(args.signal)} before the text arrived`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED }
    }
    if (err instanceof DataclusterMcpError) {
      console.warn(`[quote check] ${ark}: unverifiable, lookup failed — ${err.message}`)
      return { kind: "unverifiable", cause: QUOTE_UNVERIFIABLE_CAUSE.LOOKUP_FAILED }
    }
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
  const prior = args.priorBodyMd === null ? [] : extractQuotes(args.priorBodyMd)
  const quotes = extractQuotes(args.bodyMd).filter(
    (q) => q.words >= QUOTE_MIN_CHECKED_WORDS && !prior.some((p) => isSameQuote(p, q)),
  )
  const warnings: Array<{ index: number; w: QuoteWarning }> = []
  const push = (q: ExtractedQuote, w: QuoteWarning) => warnings.push({ index: q.index, w })

  const byArk = new Map<string, ExtractedQuote[]>()
  for (const q of quotes) {
    if (!q.citation) {
      push(q, warning(q, QUOTE_WARNING_REASON.UNCITED))
      continue
    }
    const list = byArk.get(q.citation.ark)
    if (list) list.push(q)
    else byArk.set(q.citation.ark, [q])
  }

  const arks = [...byArk.keys()]
  for (const ark of arks.slice(QUOTE_CHECK_MAX_SOURCES)) {
    for (const q of byArk.get(ark) ?? []) push(q, unverifiable(q, QUOTE_UNVERIFIABLE_CAUSE.TOO_MANY_SOURCES))
  }

  const fetched = arks.slice(0, QUOTE_CHECK_MAX_SOURCES)
  if (fetched.length > 0) {
    const signal = AbortSignal.any([args.signal, AbortSignal.timeout(QUOTE_CHECK_BUDGET_MS)])
    const outcomes = await mapConcurrent(fetched, QUOTE_CHECK_CONCURRENCY, (ark) => {
      const cited = new Set((byArk.get(ark) ?? []).flatMap((q) => (q.citation ? [q.citation.folio] : [])))
      return fetchDocument(args, ark, cited, signal)
    })

    for (const [i, ark] of fetched.entries()) {
      const outcome = outcomes[i]
      for (const q of byArk.get(ark) ?? []) {
        if (!q.citation) continue
        if (outcome.kind === "unverifiable") {
          push(q, unverifiable(q, outcome.cause))
          continue
        }
        if (!outcome.folios.has(q.citation.folio)) {
          push(q, unverifiable(q, QUOTE_UNVERIFIABLE_CAUSE.FOLIO_ABSENT))
          continue
        }
        for (const v of verifyQuote(q, outcome.doc, {
          citedFolio: q.citation.folio,
          marking: OCR_CORRECTION_MARKING,
          lowOcrFolios: outcome.low,
        })) {
          if (v.ok) continue
          push(q, warning(q, v.reason, v.foundOnFolio === undefined ? {} : { found_on_folio: v.foundOnFolio }))
        }
      }
    }
  }

  const ordered = warnings.sort((a, b) => a.index - b.index).map((x) => x.w)
  return {
    status: ordered.some((w) => w.reason === QUOTE_WARNING_REASON.UNVERIFIABLE) ? "partial" : "complete",
    checked: quotes.length,
    warnings: ordered,
  }
}
