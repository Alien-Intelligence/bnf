// lib/testing/quote-harness.test.ts
// The harness's pass criteria: each warning reason lands in the criterion the
// plan assigns it, the low-folio rule only fires on the low folio, and a run
// without a note is never a vacuous pass.
import { test } from "node:test"
import assert from "node:assert/strict"
import type { QuoteWarning } from "@/models/notes/schema"
import { QUOTE_WARNING_DETAIL } from "@/lib/agent/prompts/quote-warnings"
import { QUOTE_WARNING_REASON } from "@/models/notes/schema"
import type { QuoteWarningReason } from "@/models/notes/schema"
import {
  atLeastTwoThirds,
  casePasses,
  citedQuoteCount,
  forbiddenCompletionsIn,
  hardViolations,
  runVerdict,
} from "./quote-harness"
import type { CheckedBody, RunEvidence } from "./quote-harness"

const ARK = "ark:/12148/bpt6k822781z"
const LOW_ARK = "ark:/12148/bpt6k407182j"
const OPTS = { lowFolios: [{ ark: LOW_ARK, folio: 2 }], forbidden: ["Palais de Cristal"] }

function w(reason: QuoteWarningReason, ark = ARK, folio = 2): QuoteWarning {
  return { quote: "…", citation: { ark, folio }, reason, detail: QUOTE_WARNING_DETAIL[reason] }
}
function body(warnings: QuoteWarning[], bodyMd = "## Note\n\nTexte."): CheckedBody {
  return { bodyMd, warnings }
}
function criteria(b: CheckedBody): string[] {
  return hardViolations(b, OPTS).map((v) => v.criterion)
}

test("each reason maps to the criterion the plan assigns it", () => {
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS)])), ["H1", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.ELISION_TOO_FAR)])), ["H1", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER)])), ["H1", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.TOO_MANY_ELISIONS)])), ["H3", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.UNCITED)])), ["H4", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.UNMARKED_CORRECTION)])), ["H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.UNVERIFIABLE)])), [])
})

test("H2: not_in_cited_folio / correction_on_low_ocr count only on a low folio", () => {
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO, LOW_ARK, 2)])), ["H2", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR, LOW_ARK, 2)])), ["H2", "H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO, ARK, 2)])), ["H5"])
  assert.deepEqual(criteria(body([w(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO, LOW_ARK, 3)])), ["H5"])
})

test("H2: a forbidden completion counts only inside a quote span", () => {
  const quoted = `« Le Palais de  cristal, ce vaste édifice » [[${LOW_ARK}|S|2]]`
  const paraphrased = `Le Palais de Cristal a brûlé [[${LOW_ARK}|S|2]].`
  assert.deepEqual(forbiddenCompletionsIn(quoted, OPTS.forbidden), ["Palais de Cristal"])
  assert.deepEqual(forbiddenCompletionsIn(paraphrased, OPTS.forbidden), [])
  assert.deepEqual(criteria(body([], quoted)), ["H2"])
  assert.deepEqual(criteria(body([], paraphrased)), [])
})

test("H6: a self-written OCR disclaimer in the body", () => {
  assert.deepEqual(criteria(body([], "Attention : la lisibilité de ce document est médiocre.")), ["H6"])
  assert.deepEqual(criteria(body([], "La reconnaissance du texte est imparfaite.")), ["H6"])
})

test("H6: the disclaimers the baseline agents actually wrote", () => {
  // Verbatim from the 2026-10-02 baseline (C3 runs 1 and 3); the plan's
  // original regex matched neither.
  assert.deepEqual(criteria(body([], "Le texte est conservé dans un état d'OCR dégradé (caractères altérés).")), ["H6"])
  assert.deepEqual(criteria(body([], "> ⚠️ Le texte OCR d'origine est fortement dégradé (caractères substitués).")), ["H6"])
  assert.deepEqual(criteria(body([], "La numérisation a dégradé l'OCR de cette page.")), ["H6"])
  // Not a disclaimer: a fact about the building, or a neutral mention of OCR.
  assert.deepEqual(criteria(body([], "Le bâtiment, très dégradé, fut démoli. Le texte vient de l'OCR de Gallica.")), [])
})

test("S2: distinct, cited, checkable quotes", () => {
  const md =
    `« Les premiers témoins accusent l'imprudence » [[${ARK}|S|2]] puis « un court-circuit a provoqué le sinistre » ` +
    `[[${ARK}|S|2]], encore « un court-circuit a provoqué le sinistre » [[${ARK}|S|2]] et « Le Populaire » [[${ARK}|S|1]].`
  assert.equal(citedQuoteCount(md), 2)
})

test("casePasses: final notes must pass in every run; first writes in ≥ 2/3", () => {
  const clean: RunEvidence = { noteWritten: true, firstWrites: [body([])], finalNotes: [body([])] }
  const stitchedThenFixed: RunEvidence = {
    noteWritten: true,
    firstWrites: [body([w(QUOTE_WARNING_REASON.ELISION_TOO_FAR)])],
    finalNotes: [body([])],
  }
  const stitchedKept: RunEvidence = {
    noteWritten: true,
    firstWrites: [body([w(QUOTE_WARNING_REASON.ELISION_TOO_FAR)])],
    finalNotes: [body([w(QUOTE_WARNING_REASON.ELISION_TOO_FAR)])],
  }
  const noNote: RunEvidence = { noteWritten: false, firstWrites: [], finalNotes: [] }

  assert.deepEqual(casePasses([clean, clean, stitchedThenFixed], OPTS), {
    finalOk: true,
    firstWriteOk: true,
    firstWritePassing: 2,
  })
  assert.deepEqual(casePasses([clean, stitchedThenFixed, stitchedThenFixed], OPTS), {
    finalOk: true,
    firstWriteOk: false,
    firstWritePassing: 1,
  })
  assert.equal(casePasses([clean, clean, stitchedKept], OPTS).finalOk, false)
  assert.deepEqual(casePasses([clean, clean, noNote], OPTS), { finalOk: false, firstWriteOk: true, firstWritePassing: 2 })
  assert.deepEqual([...runVerdict(stitchedThenFixed, OPTS).firstWrite], ["H1", "H5"])
})

test("no runs is no evidence: casePasses([]) and atLeastTwoThirds(0, 0) fail", () => {
  assert.deepEqual(casePasses([], OPTS), { finalOk: false, firstWriteOk: false, firstWritePassing: 0 })
  assert.equal(atLeastTwoThirds(0, 0), false)
  assert.equal(atLeastTwoThirds(2, 3), true)
  assert.equal(atLeastTwoThirds(1, 3), false)
})
