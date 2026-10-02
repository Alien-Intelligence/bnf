// lib/citations/quote-check.test.ts
// The orchestrator's bounds and error classification, with the cluster facade
// stubbed. The matcher itself is covered by quote-match.test.ts.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { ClusterRagClient } from "@/lib/cluster/rag"
import type { DocumentFoliosRequest, DocumentFoliosResult } from "@/lib/cluster/rag"
import { DataclusterMcpError } from "@/lib/cluster/datacluster-mcp-client"
import { QUOTE_CHECK_MAX_SOURCES } from "@/lib/constants"
import {
  QUOTE_UNVERIFIABLE_CAUSE,
  QUOTE_WARNING_DETAIL,
  QUOTE_WARNING_REASON,
} from "@/models/notes/schema"
import { checkNoteQuotes } from "./quote-check"

const PROJECT = "corpus-project"
const QUOTE = "Les premiers témoins accusent l'imprudence du personnel des cuisines"
const FOLIO_TEXT = `Hier soir, au casino. ${QUOTE}. Rien n'est établi.`

function arkN(n: number): string {
  return `ark:/12148/bpt6k${String(n).padStart(7, "0")}`
}
function cite(ark: string, folio: number): string {
  return `[[${ark}|Source|${folio}]]`
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
  status: "found",
  entryId: 1,
  folios: new Map(folios),
})

test("an exact quote on its cited folio is checked and draws no warning", async () => {
  const res = await withFacade(
    async () => found([[2, FOLIO_TEXT]]),
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`,
        priorBodyMd: null,
        signal: new AbortController().signal,
      }),
  )
  assert.deepEqual(res, { status: "complete", checked: 1, warnings: [] })
})

test("budget exhaustion makes the quote unverifiable / budget_exceeded", async () => {
  const res = await withFacade(
    () => new Promise<DocumentFoliosResult>(() => {}),
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`,
        priorBodyMd: null,
        // The budget is composed from this signal; a short one stands in for
        // QUOTE_CHECK_BUDGET_MS without waiting 20 s.
        signal: AbortSignal.timeout(100),
      }),
  )
  assert.equal(res.status, "partial")
  assert.equal(res.checked, 1)
  assert.equal(res.warnings.length, 1)
  assert.equal(res.warnings[0].reason, QUOTE_WARNING_REASON.UNVERIFIABLE)
  assert.equal(res.warnings[0].cause, QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED)
  assert.equal(res.warnings[0].detail, QUOTE_WARNING_DETAIL[QUOTE_WARNING_REASON.UNVERIFIABLE])
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
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: body,
        priorBodyMd: null,
        signal: new AbortController().signal,
      }),
  )
  assert.equal(res.status, "partial")
  assert.equal(res.checked, n)
  assert.equal(fetched.length, QUOTE_CHECK_MAX_SOURCES)
  assert.equal(res.warnings.length, 1)
  assert.equal(res.warnings[0].reason, QUOTE_WARNING_REASON.UNVERIFIABLE)
  assert.equal(res.warnings[0].cause, QUOTE_UNVERIFIABLE_CAUSE.TOO_MANY_SOURCES)
  assert.deepEqual(res.warnings[0].citation, { ark: arkN(n), folio: 2 })
})

test("entry_not_found and folio_absent are reported as unverifiable with their cause", async () => {
  const res = await withFacade(
    async (req) => (req.ark === arkN(1) ? { status: "entry_not_found" } : found([[2, FOLIO_TEXT]])),
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}\n\n« ${QUOTE} » ${cite(arkN(2), 9)}`,
        priorBodyMd: null,
        signal: new AbortController().signal,
      }),
  )
  assert.equal(res.status, "partial")
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
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}\n\n« ${QUOTE} » ${cite(arkN(2), 2)}`,
        priorBodyMd: null,
        signal: new AbortController().signal,
      }),
  )
  assert.equal(res.status, "partial")
  assert.equal(res.checked, 2)
  assert.deepEqual(
    res.warnings.map((w) => [w.citation?.ark, w.cause]),
    [[arkN(1), QUOTE_UNVERIFIABLE_CAUSE.LOOKUP_FAILED]],
  )
})

test("an unexpected error (not a cluster error, not an abort) propagates to the caller", async () => {
  await assert.rejects(
    withFacade(
      async () => {
        throw new TypeError("boom")
      },
      () =>
        checkNoteQuotes({
          corpusProjectId: PROJECT,
          bodyMd: `« ${QUOTE} » ${cite(arkN(1), 2)}`,
          priorBodyMd: null,
          signal: new AbortController().signal,
        }),
    ),
    TypeError,
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
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `${prior}\n\nLe terme « Alamans » et « cette phrase n'est citée nulle part ».`,
        priorBodyMd: prior,
        signal: new AbortController().signal,
      }),
  )
  assert.equal(fetches, 0)
  assert.equal(res.status, "complete")
  assert.equal(res.checked, 1)
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.citation]),
    [[QUOTE_WARNING_REASON.UNCITED, null]],
  )
})

test("the low-OCR lookup is consulted and correction_on_low_ocr surfaces", async () => {
  const res = await withFacade(
    async () => found([[2, "ce vaste éd:f..e n'est plus qu'un amas de ruines fumantes"]]),
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `« n'est plus qu'un amas de [ruines] fumantes » ${cite(arkN(1), 2)}`,
        priorBodyMd: null,
        signal: new AbortController().signal,
        lowOcrFolios: async () => new Set([2]),
      }),
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
    () =>
      checkNoteQuotes({
        corpusProjectId: PROJECT,
        bodyMd: `Les témoins: « ${QUOTE} » ${cite(arkN(1), 3)}.`,
        priorBodyMd: before,
        signal: new AbortController().signal,
      }),
  )
  assert.equal(res.checked, 1, "the newly cited quote is in scope")
  assert.deepEqual(
    res.warnings.map((w) => [w.reason, w.found_on_folio]),
    [[QUOTE_WARNING_REASON.UNVERIFIABLE, undefined]],
    "folio 3 is absent from the stub document: the new citation was actually checked",
  )
})
