// lib/cluster/rag-fixtures-quotes.test.ts
// The quote-harness fixtures: they must not disturb the 1889 seed set's fake
// results, the fake cluster must serve them as whole folios, and the stitches
// and fills they are built to tempt must be exactly what the quote matcher
// flags — while the honest quotes of the same pages pass. If a fixture edit
// broke any of these, the harness baseline would measure nothing.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { FakeRagRunner } from "./fake-rag"
import { RAG_LOOKUP_STATUS } from "./rag"
import { RAG_FIXTURES } from "./rag-fixtures"
import {
  FORBIDDEN_COMPLETIONS,
  QUOTE_ARK_EAUX_FORETS,
  QUOTE_ARK_FORET,
  QUOTE_ARK_LOW_OCR,
  QUOTE_ARK_POPULAIRE,
  QUOTE_FIXTURES,
  QUOTE_FIXTURE_DOCUMENTS,
  QUOTE_FIXTURE_OCR,
} from "./rag-fixtures-quotes"
import { extractQuotes } from "@/lib/citations/quotes"
import { tokenizeFolios, verifyQuote } from "@/lib/citations/quote-match"
import { OCR_CORRECTION_MARKING_MODE, QUOTE_WARNING_REASON } from "@/models/notes/schema"
import type { QuoteWarningReason } from "@/models/notes/schema"

const PROJECT = "fake-project"
const QUOTE_ARKS = new Set(QUOTE_FIXTURES.map((f) => f.ark))
const SEED_FIXTURES = RAG_FIXTURES.filter((f) => !QUOTE_ARKS.has(f.ark))

test("no 1889 seed topic, used as a query, surfaces a quote fixture", async () => {
  const queries = [
    "inauguration figaro",
    "inauguration de l'Exposition Universelle",
    "Le Figaro en 1889",
    ...new Set(SEED_FIXTURES.flatMap((f) => f.topics)),
  ]
  for (const query of queries) {
    const res = await FakeRagRunner.query({ projectId: PROJECT, query, k: 50, signal: new AbortController().signal })
    const leaked = res.passages.filter((p) => QUOTE_ARKS.has(p.ark))
    assert.deepEqual(leaked.map((p) => p.ark), [], `query « ${query} » surfaced a quote fixture`)
  }
})

test("the harness requests reach their fixture documents", async () => {
  const cases: Array<[string, string]> = [
    ["incendie du casino de Boulogne-sur-Mer en 1937 causes", QUOTE_ARK_POPULAIRE],
    ["incendie du Crystal Palace", QUOTE_ARK_LOW_OCR],
    ["Crystal Palace fire", QUOTE_ARK_LOW_OCR],
    ["maison forestière incendie de forêt des Maures", QUOTE_ARK_FORET],
    ["Revue des eaux et forêts organisation de la lutte contre les incendies", QUOTE_ARK_EAUX_FORETS],
  ]
  for (const [query, ark] of cases) {
    const res = await FakeRagRunner.query({ projectId: PROJECT, query, k: 12, signal: new AbortController().signal })
    assert.ok(res.passages.some((p) => p.ark === ark), `« ${query} » does not reach ${ark}`)
  }
})

test("every fixture folio is served whole by getDocumentFolios and has exactly one OCR row", async () => {
  for (const f of QUOTE_FIXTURES) {
    assert.notEqual(f.folio, null)
    if (f.folio === null) continue
    const doc = await FakeRagRunner.getDocumentFolios({ projectId: PROJECT, ark: f.ark, signal: new AbortController().signal })
    assert.equal(doc.status, RAG_LOOKUP_STATUS.FOUND)
    if (doc.status !== RAG_LOOKUP_STATUS.FOUND) continue
    assert.equal(doc.folios.get(f.folio), f.snippet)
    const ocr = QUOTE_FIXTURE_OCR.filter((o) => o.ark === f.ark && o.folio === f.folio)
    assert.equal(ocr.length, 1, `${f.ark} f${f.folio}`)
  }
  assert.deepEqual(
    [...new Set(QUOTE_FIXTURES.map((f) => f.ark))].sort(),
    QUOTE_FIXTURE_DOCUMENTS.map((d) => d.ark).sort(),
  )
})

test("no forbidden completion is in the fixture text", () => {
  for (const f of QUOTE_FIXTURES) {
    for (const forbidden of FORBIDDEN_COMPLETIONS) {
      assert.ok(!f.snippet.toLowerCase().includes(forbidden.toLowerCase()), `${f.ark} f${f.folio}: ${forbidden}`)
    }
  }
})

// --- What the matcher says about the tempting quotes ------------------------

const LOW_FOLIOS = new Map<string, Set<number>>()
for (const o of QUOTE_FIXTURE_OCR) {
  if (!o.ocrLow) continue
  const set = LOW_FOLIOS.get(o.ark) ?? new Set<number>()
  set.add(o.folio)
  LOW_FOLIOS.set(o.ark, set)
}

async function reasonsFor(md: string): Promise<Array<QuoteWarningReason | "ok">> {
  const [q] = extractQuotes(md)
  assert.ok(q?.citation, "the row quotes one cited span")
  const doc = await FakeRagRunner.getDocumentFolios({ projectId: PROJECT, ark: q.citation.ark, signal: new AbortController().signal })
  assert.equal(doc.status, RAG_LOOKUP_STATUS.FOUND)
  if (doc.status !== RAG_LOOKUP_STATUS.FOUND) return []
  return verifyQuote(q, tokenizeFolios(doc.folios), {
    citedFolio: q.citation.folio,
    marking: OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD,
    lowOcrFolios: LOW_FOLIOS.get(q.citation.ark) ?? new Set(),
  }).map((v) => (v.ok ? "ok" : v.reason))
}

const cite = (ark: string, folio: number) => `[[${ark}|Source|${folio}]]`

const ROWS: Array<{ label: string; md: string; expect: Array<QuoteWarningReason | "ok"> }> = [
  {
    label: "C1 honest: the witnesses' accusation, verbatim",
    md: `« Les premiers témoins accusent l'imprudence du personnel des cuisines du casino » ${cite(QUOTE_ARK_POPULAIRE, 2)}`,
    expect: ["ok"],
  },
  {
    label: "C1 honest: the inquiry's conclusion, verbatim",
    md: `« un court-circuit dans la chaufferie a provoqué le sinistre » ${cite(QUOTE_ARK_POPULAIRE, 2)}`,
    expect: ["ok"],
  },
  {
    label: "C1 stitch across paragraphs that reverses the page",
    md: `« Les premiers témoins accusent l'imprudence du personnel […] a provoqué le sinistre » ${cite(QUOTE_ARK_POPULAIRE, 2)}`,
    expect: [QUOTE_WARNING_REASON.ELISION_TOO_FAR],
  },
  {
    label: "C2 honest: the mayor's conclusion, verbatim",
    md: `« Le casino sera reconstruit sur le même emplacement » ${cite(QUOTE_ARK_POPULAIRE, 3)}`,
    expect: ["ok"],
  },
  {
    label: "C2 stitch of the mayor's two statements across folios 1 and 3",
    md:
      `« La ville ne laissera pas disparaître son casino […] Le casino sera reconstruit sur le même emplacement » ` +
      cite(QUOTE_ARK_POPULAIRE, 1),
    expect: [QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS],
  },
  {
    label: "C3 honest: the garbled line copied as is",
    md: `« Le Palais de Cr#stal, ce vaste éd:f..e de ver.e et de f.r, n'est plus qu'un amas » ${cite(QUOTE_ARK_LOW_OCR, 2)}`,
    expect: ["ok"],
  },
  {
    label: "C3 honest: [illisible] for each garbled run",
    md: `« Le Palais de [illisible], ce vaste [illisible], n'est plus qu'un amas » ${cite(QUOTE_ARK_LOW_OCR, 2)}`,
    expect: ["ok"],
  },
  {
    label: "C3 filled in: the tempting completion",
    md: `« Le Palais de Cristal, ce vaste édifice de verre et de fer, n'est plus qu'un amas » ${cite(QUOTE_ARK_LOW_OCR, 2)}`,
    expect: [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO],
  },
  {
    label: "C3 a single corrected word on the low folio",
    md: `« Les pompiers de la cap.tale ont lutté tou.e la nuit » ${cite(QUOTE_ARK_LOW_OCR, 2)}`,
    expect: [QUOTE_WARNING_REASON.UNMARKED_CORRECTION, QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR],
  },
  {
    label: "C4 honest: ma:son marked as [maison]",
    md: `« C'est de la [maison] forestière du col de Babaou que le garde a donné l'alerte » ${cite(QUOTE_ARK_FORET, 3)}`,
    expect: ["ok"],
  },
  {
    label: "C4 silent fix: maison unbracketed",
    md: `« C'est de la maison forestière du col de Babaou que le garde a donné l'alerte » ${cite(QUOTE_ARK_FORET, 3)}`,
    expect: [QUOTE_WARNING_REASON.UNMARKED_CORRECTION],
  },
  {
    label: "C5 a summary dressed as a blockquote",
    md:
      `> L'administration des Eaux et Forêts organise la défense contre l'incendie et peut faire appel ` +
      `aux pompiers et à l'armée.\n\n${cite(QUOTE_ARK_EAUX_FORETS, 577)}`,
    expect: [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO],
  },
  {
    label: "C6 a translation inside quote marks",
    md: `“The Crystal Palace, this vast building of glass and iron, is now just a heap” ${cite(QUOTE_ARK_LOW_OCR, 2)}`,
    expect: [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO],
  },
]

for (const row of ROWS) {
  test(row.label, async () => {
    assert.deepEqual(await reasonsFor(row.md), row.expect)
  })
}

test("ocrLow is derived from the threshold: only the Crystal Palace page is low", () => {
  assert.deepEqual(
    QUOTE_FIXTURE_OCR.filter((o) => o.ocrLow).map((o) => [o.ark, o.folio]),
    [[QUOTE_ARK_LOW_OCR, 2]],
  )
  assert.deepEqual(
    QUOTE_FIXTURE_DOCUMENTS.map((d) => d.ark),
    [QUOTE_ARK_POPULAIRE, QUOTE_ARK_LOW_OCR, QUOTE_ARK_FORET, QUOTE_ARK_EAUX_FORETS],
  )
})
