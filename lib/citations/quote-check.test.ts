// lib/citations/quote-check.test.ts
// The orchestrator's bounds, error classification and honesty, with the
// cluster facade stubbed. The matcher itself is covered by quote-match.test.ts.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { ClusterRagClient, RAG_LOOKUP_STATUS } from "@/lib/cluster/rag"
import type { DocumentFoliosRequest, DocumentFoliosResult } from "@/lib/cluster/rag"
import { DataclusterMcpError } from "@/lib/cluster/datacluster-mcp-client"
import { FolioMapAmbiguousError } from "@/lib/cluster/folio-text"
import { QUOTE_CHECK_MAX_SOURCES, QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK } from "@/lib/constants"
import { QUOTE_WARNING_DETAIL } from "@/lib/agent/prompts/quote-warnings"
import {
  QUOTE_CHECK_STATUS,
  QUOTE_UNVERIFIABLE_CAUSE,
  QUOTE_WARNING_REASON,
} from "@/models/notes/schema"
import { checkNoteQuotes } from "./quote-check"
import type { CheckNoteQuotesArgs, LowOcrFoliosLookup } from "./quote-check"

const PROJECT = "corpus-project"
const QUOTE = "Les premiers témoins accusent l'imprudence du personnel des cuisines"
const FOLIO_TEXT = `Hier soir, au casino. ${QUOTE}. Rien n'est établi.`
const BUDGET_MS = 20_000

function arkN(n: number): string {
  return `ark:/12148/bpt6k${String(n).padStart(7, "0")}`
}
function cite(ark: string, folio: number): string {
  return `[[${ark}|Source|${folio}]]`
}
/** A quality lookup that knows of no low folio. */
const noLowFolios: LowOcrFoliosLookup = async () => new Set()

function args(over: Partial<CheckNoteQuotesArgs> & Pick<CheckNoteQuotesArgs, "bodyMd">): CheckNoteQuotesArgs {
  return {
    corpusProjectId: PROJECT,
    priorBodyMd: null,
    signal: new AbortController().signal,
    lowOcrFolios: noLowFolios,
    budgetMs: BUDGET_MS,
    ...over,
  }
}

async function withFacade<T>(
  impl: (req: DocumentFoliosRequest) => Promise<DocumentFoliosResult>,
  run: () => Promise<T>,
): Promise<T> {
  const original = ClusterRagClient.getDocumentFolios
  ClusterRagClient.getDocumentFolios = impl
  try {
    return await run()
  } finally {
    ClusterRagClient.getDocumentFolios = original
  }
}

const found = (folios: Array<[number, string]>): DocumentFoliosResult => ({
  status: RAG_LOOKUP_STATUS.FOUND,
  entryId: 1,
  folios: new Map(folios),
})

/** Resolves only when the request's signal aborts, then rejects with its reason. */
function hangsUntilAborted(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
  return new Promise((_, reject) => {
    req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })
  })
}

test("an exact quote on its cited folio, with quality data, is checked and complete", async () => {
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}` })),
  )
  assert.deepEqual(res, { status: QUOTE_CHECK_STATUS.COMPLETE, checked: 1, warnings: [], unevaluated_rules: [] })
})

test("without a quality lookup, correction_on_low_ocr is unevaluated and the check is partial, never complete", async () => {
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, lowOcrFolios: null })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.deepEqual(res.unevaluated_rules, [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR])
  assert.deepEqual(res.warnings, [])
})

test("the budget running out makes the quote unverifiable / budget_exceeded", async () => {
  const res = await withFacade(hangsUntilAborted, () =>
    checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, budgetMs: 50 })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.cause, w.detail]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED, QUOTE_WARNING_DETAIL[QUOTE_WARNING_REASON.UNVERIFIABLE]]],
  )
})

test("a cancelled turn is reported as cancelled, not as a budget overrun", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const res = await withFacade(hangsUntilAborted, () =>
    checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, signal: controller.signal })),
  )
  assert.deepEqual(res.warnings.map((w) => w.cause), [QUOTE_UNVERIFIABLE_CAUSE.CANCELLED])
})

test("the budget also bounds the synchronous work: past the deadline, the rest is budget_exceeded", async () => {
  // The quality lookup blocks the event loop past the deadline, so no timer
  // can fire: only the deadline check between documents can catch it.
  const slowLookup: LowOcrFoliosLookup = async () => {
    const start = Date.now()
    while (Date.now() - start < 30) {
      // busy: a slow synchronous step
    }
    return new Set()
  }
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, lowOcrFolios: slowLookup, budgetMs: 10 })),
  )
  assert.deepEqual(res.warnings.map((w) => w.cause), [QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED])
})

test("an AbortError neither signal caused (from inside the quality lookup) propagates", async () => {
  const abortingLookup: LowOcrFoliosLookup = async () => {
    throw new DOMException("db statement aborted", "AbortError")
  }
  await assert.rejects(
    withFacade(
      async () => found([[2, FOLIO_TEXT]]),
      () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, lowOcrFolios: abortingLookup })),
    ),
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  )
})

test("an unexpected failure on one ARK aborts the sibling fetches and propagates", async () => {
  const siblingSignals: AbortSignal[] = []
  await assert.rejects(
    withFacade(
      async (req) => {
        if (req.ark === arkN(1)) throw new TypeError("boom")
        siblingSignals.push(req.signal)
        return hangsUntilAborted(req)
      },
      () =>
        checkNoteQuotes(
          args({ bodyMd: `« ${QUOTE} » ${cite(arkN(2), 2)}\n\n« ${QUOTE} » ${cite(arkN(1), 2)}` }),
        ),
    ),
    TypeError,
  )
  assert.equal(siblingSignals.length, 1)
  assert.equal(siblingSignals[0].aborted, true, "the sibling's fetch was told to stop")
})

test("more than QUOTE_CHECK_MAX_SOURCES ARKs: the overflow is unverifiable / too_many_sources", async () => {
  const n = QUOTE_CHECK_MAX_SOURCES + 1
  const body = Array.from({ length: n }, (_, i) => `« ${QUOTE} » ${cite(arkN(i + 1), 2)}`).join("\n\n")
  const fetched: string[] = []
  const res = await withFacade(
    async (req) => {
      fetched.push(req.ark)
      return found([[2, FOLIO_TEXT]])
    },
    () => checkNoteQuotes(args({ bodyMd: body })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.equal(res.checked, n)
  assert.equal(fetched.length, QUOTE_CHECK_MAX_SOURCES)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.cause, w.citation]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.TOO_MANY_SOURCES, { ark: arkN(n), folio: 2 }]],
  )
})

test("entry_not_found and folio_absent are reported as unverifiable with their cause", async () => {
  const res = await withFacade(
    async (req) => (req.ark === arkN(1) ? { status: RAG_LOOKUP_STATUS.ENTRY_NOT_FOUND } : found([[2, FOLIO_TEXT]])),
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}\n\n« ${QUOTE} » ${cite(arkN(2), 9)}` })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.deepEqual(
    res.warnings.map((w) => [w.citation?.ark, w.reason, w.cause]),
    [
      [arkN(1), QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.ENTRY_NOT_FOUND],
      [arkN(2), QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.FOLIO_ABSENT],
    ],
  )
})

test("a cluster error for one ARK is lookup_failed for that ARK only", async () => {
  const res = await withFacade(
    async (req) => {
      if (req.ark === arkN(1)) throw new DataclusterMcpError("HTTP 503")
      return found([[2, FOLIO_TEXT]])
    },
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}\n\n« ${QUOTE} » ${cite(arkN(2), 2)}` })),
  )
  assert.equal(res.checked, 2)
  assert.deepEqual(
    res.warnings.map((w) => [w.citation?.ark, w.cause]),
    [[arkN(1), QUOTE_UNVERIFIABLE_CAUSE.LOOKUP_FAILED]],
  )
})

test("an entry whose folio map cannot be trusted is folio_map_ambiguous for that ARK only, never a guess", async () => {
  const res = await withFacade(
    async (req) => {
      if (req.ark === arkN(1)) throw new FolioMapAmbiguousError("heading ## Folio 3 after ## Folio 7")
      return found([[2, FOLIO_TEXT]])
    },
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}\n\n« ${QUOTE} » ${cite(arkN(2), 2)}` })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.deepEqual(
    res.warnings.map((w) => [w.citation?.ark, w.reason, w.cause]),
    [[arkN(1), QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.FOLIO_MAP_AMBIGUOUS]],
  )
})

test("uncited quotes are reported without any fetch; short spans and prior-body quotes are skipped", async () => {
  let fetches = 0
  const prior = `« ${QUOTE} » ${cite(arkN(1), 2)}`
  const res = await withFacade(
    async () => {
      fetches++
      return found([[2, FOLIO_TEXT]])
    },
    () =>
      checkNoteQuotes(
        args({ bodyMd: `${prior}\n\nLe terme « Alamans » et « cette phrase n'est citée nulle part ».`, priorBodyMd: prior }),
      ),
  )
  assert.equal(fetches, 0)
  assert.equal(res.status, QUOTE_CHECK_STATUS.COMPLETE)
  assert.equal(res.checked, 1)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.citation]),
    [[QUOTE_WARNING_REASON.UNCITED, null]],
  )
})

test("an unclosed « is reported, and does not hide the quote after it", async () => {
  const body = `Il écrit « une phrase jamais refermée, puis « ${QUOTE} » ${cite(arkN(1), 2)}.`
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: body })),
  )
  assert.equal(res.checked, 1, "the closed quote after the unclosed mark is still checked")
  assert.deepEqual(res.warnings.map((w) => w.reason), [QUOTE_WARNING_REASON.UNBALANCED_QUOTE_MARK])
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL, "text behind an unclosed mark went unchecked")
})

test("the low-OCR lookup is consulted and correction_on_low_ocr surfaces", async () => {
  const res = await withFacade(
    async () => found([[2, "ce vaste éd:f..e n'est plus qu'un amas de ruines fumantes"]]),
    () =>
      checkNoteQuotes(
        args({ bodyMd: `« n'est plus qu'un amas de [ruines] fumantes » ${cite(arkN(1), 2)}`, lowOcrFolios: async () => new Set([2]) }),
      ),
  )
  assert.deepEqual(
    res.warnings.map((w) => w.reason),
    [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR],
  )
})

test("prior-body rule: a quote that gains (or changes) its citation is re-checked", async () => {
  const before = `Les témoins: « ${QUOTE} ».`
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: `Les témoins: « ${QUOTE} » ${cite(arkN(1), 3)}.`, priorBodyMd: before })),
  )
  assert.equal(res.checked, 1, "the newly cited quote is in scope")
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.cause]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.FOLIO_ABSENT]],
    "folio 3 is absent from the stub document: the new citation was actually checked",
  )
})

test("budgetMs must be a positive integer (NaN would disable the deadline)", async () => {
  for (const budgetMs of [Number.NaN, 0, -5, 1.5]) {
    await assert.rejects(checkNoteQuotes(args({ bodyMd: "Rien.", budgetMs })), RangeError)
  }
})

// ---------------------------------------------------------------------------
// Bounded work: every synchronous loop stops within budget × 2 of the start
// (one stride of work plus scheduling past the deadline), measured on the
// same monotonic clock the check uses.
// ---------------------------------------------------------------------------

const TIGHT_BUDGET_MS = 200

async function timed<T>(run: () => Promise<T>): Promise<{ res: T; elapsedMs: number }> {
  const started = performance.now()
  const res = await run()
  return { res, elapsedMs: performance.now() - started }
}

test("the deadline interrupts the alignment of a large document within budget × 2", async () => {
  // ~300 000 source tokens, none of which match: aligning a quote against it
  // is long synchronous work that only an in-loop deadline check can stop.
  const huge = Array.from({ length: 300_000 }, (_, i) => `mot${i % 997}`).join(" ")
  const body = Array.from({ length: 20 }, (_, i) => `« quatre mots absents numero${i} ici » ${cite(arkN(1), 2)}`).join("\n\n")
  const { res, elapsedMs } = await timed(() =>
    withFacade(async () => found([[2, huge]]), () => checkNoteQuotes(args({ bodyMd: body, budgetMs: TIGHT_BUDGET_MS }))),
  )
  assert.ok(elapsedMs <= TIGHT_BUDGET_MS * 2, `stopped within budget × 2 (${elapsedMs.toFixed(0)} ms)`)
  assert.ok(
    res.warnings.some((w) => w.cause === QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED),
    "the quotes left when the deadline passed are budget_exceeded",
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
})

test("a 4 000-word quote that nearly matches everywhere stops within budget × 2, as budget_exceeded", async () => {
  // Every other source token is a candidate start that aligns ~4 000 tokens
  // before failing on the last word: the stop has to come from inside the
  // alignment, which is also iterative (no stack overflow at this length).
  const quoteWords = Array.from({ length: 4_000 }, (_, i) => (i % 2 === 0 ? "alpha" : "beta"))
  const nearMiss = [...quoteWords.slice(0, -1), "qqqqqqqq"].join(" ")
  const doc = Array.from({ length: 20 }, () => nearMiss).join(" ")
  const { res, elapsedMs } = await timed(() =>
    withFacade(
      async () => found([[2, doc]]),
      () => checkNoteQuotes(args({ bodyMd: `« ${quoteWords.join(" ")} » ${cite(arkN(1), 2)}`, budgetMs: TIGHT_BUDGET_MS })),
    ),
  )
  assert.ok(elapsedMs <= TIGHT_BUDGET_MS * 2, `stopped within budget × 2 (${elapsedMs.toFixed(0)} ms)`)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.cause]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED]],
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
})

/** One paragraph of ~200 KB holding thousands of cited quotes. */
function denseParagraph(): string {
  const parts: string[] = []
  let length = 0
  for (let i = 0; length < 200_000; i++) {
    const part = `« quatre mots présents numero${i} ici » ${cite(arkN(1), 2)} `
    parts.push(part)
    length += part.length
  }
  return parts.join("")
}

test("a dense 200 KB paragraph stops (or finishes) within budget × 2: scan, attribution and matching are bounded", async () => {
  const body = denseParagraph()
  const { res, elapsedMs } = await timed(() =>
    withFacade(async () => found([[2, FOLIO_TEXT]]), () => checkNoteQuotes(args({ bodyMd: body, budgetMs: TIGHT_BUDGET_MS }))),
  )
  assert.ok(elapsedMs <= TIGHT_BUDGET_MS * 2, `stopped within budget × 2 (${elapsedMs.toFixed(0)} ms)`)
  assert.ok(res.checked > 2_500, `the quotes were extracted (${res.checked})`)
  // None of them is on the folio: each is either reported or, past the
  // deadline, budget_exceeded — never silently passed.
  assert.ok(
    res.warnings.every(
      (w) => w.reason === QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO || w.cause === QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED,
    ),
  )
})

test("a dense 200 KB paragraph re-sent as its own prior body is filtered within budget × 2", async () => {
  const body = denseParagraph()
  let fetches = 0
  const { res, elapsedMs } = await timed(() =>
    withFacade(
      async () => {
        fetches++
        return found([[2, FOLIO_TEXT]])
      },
      () => checkNoteQuotes(args({ bodyMd: body, priorBodyMd: body, budgetMs: TIGHT_BUDGET_MS })),
    ),
  )
  assert.ok(elapsedMs <= TIGHT_BUDGET_MS * 2, `stopped within budget × 2 (${elapsedMs.toFixed(0)} ms)`)
  // Every quote was already in the prior body: nothing is in scope, nothing fetched.
  assert.equal(res.checked, 0)
  assert.equal(fetches, 0)
})

test("past the stray-mark cap, the rest of the block is reported as unscanned and the result is partial", async () => {
  const stray = Array.from({ length: QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK + 5 }, (_, i) => `« ouvert${i}`).join(" ")
  const body = `« ${QUOTE} » ${cite(arkN(1), 2)} ${stray} « ${QUOTE} » ${cite(arkN(1), 2)}`
  const res = await withFacade(async () => found([[2, FOLIO_TEXT]]), () => checkNoteQuotes(args({ bodyMd: body })))
  const reasons = res.warnings.map((w) => w.reason)
  assert.equal(reasons.filter((r) => r === QUOTE_WARNING_REASON.UNBALANCED_QUOTE_MARK).length, QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK)
  assert.equal(reasons.filter((r) => r === QUOTE_WARNING_REASON.UNSCANNED_REST_OF_BLOCK).length, 1)
  assert.equal(
    res.warnings.find((w) => w.reason === QUOTE_WARNING_REASON.UNSCANNED_REST_OF_BLOCK)?.detail,
    QUOTE_WARNING_DETAIL[QUOTE_WARNING_REASON.UNSCANNED_REST_OF_BLOCK],
  )
  assert.equal(res.checked, 1, "the quote before the cap is checked; the one after it was not scanned")
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
})

test("a stopped scan of the body is reported unverifiable with the reason, from where it stopped", async () => {
  const controller = new AbortController()
  controller.abort()
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () => checkNoteQuotes(args({ bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`, signal: controller.signal })),
  )
  assert.equal(res.status, QUOTE_CHECK_STATUS.PARTIAL)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.cause, w.quote.slice(0, 1)]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, QUOTE_UNVERIFIABLE_CAUSE.CANCELLED, "«"]],
  )
})
