// lib/citations/quote-match.test.ts
// Labelled table for the pure matcher: one row per warning reason, plus the
// legitimate patterns that MUST pass. A false positive costs a needless
// rewrite and user-visible churn, so the passing rows matter as much as the
// failing ones.
import { test } from "node:test"
import assert from "node:assert/strict"
import { extractQuotes } from "./quotes"
import { tokenizeFolios, verifyQuote } from "./quote-match"
import type { QuoteVerdict } from "./quote-match"
import { OCR_CORRECTION_MARKING_MODE, QUOTE_WARNING_REASON } from "@/models/notes/schema"

const ARK = "ark:/12148/bpt6k822781z"
const CITE = (folio: number) => `[[${ARK}|Le Populaire, 1937|${folio}]]`

const filler = Array.from({ length: 60 }, (_, i) => `mot${i + 1}`).join(" ")

const FOLIOS = new Map<number, string>([
  [
    1,
    "Le maire a déclaré hier soir que la ma:son forestière avait brûlé depuis l'aube et que le feu gagnait la répu\nblique voisine. " +
      "Les premiers témoins accusent l'imprudence du personnel des cuisines. Rien n'est encore établi.\n\n" +
      "L'enquête a établi que l'imprudence n'y est pour rien : un court-circuit a provoqué le sinistre.",
  ],
  [2, "le Palais de Cr#stal, ce vaste éd:f..e de ver.e et de f.r, n'est plus qu'un amas de ruines fumantes"],
  [3, "Le conseil municipal se réunira demain pour voter les secours aux sinistrés."],
  [4, `Début de la phrase ${filler} fin de la phrase.`],
  [5, "Première phrase du rapport. Deuxième phrase du rapport. Troisième phrase du rapport ici même."],
  [7, "Nous ne reviendrons pas sur les causes exactes de cet incendie dramatique."],
])
const DOC = tokenizeFolios(FOLIOS)

type Row = {
  label: string
  md: string
  cited: number
  marking?: "bracketed_word" | "silent"
  low?: number[]
  expect: "ok" | Array<(typeof QUOTE_WARNING_REASON)[keyof typeof QUOTE_WARNING_REASON]>
  foundOnFolio?: number
  fuzzy?: number
}

const ROWS: Row[] = [
  {
    label: "exact quote on the cited folio",
    md: `« Les premiers témoins accusent l'imprudence du personnel des cuisines » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
    fuzzy: 0,
  },
  {
    label: "ma:son → [maison] passes in bracketed mode",
    md: `« la [maison] forestière avait brûlé depuis l'aube » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
    fuzzy: 1,
  },
  {
    label: "ma:son → maison unbracketed is unmarked_correction",
    md: `« la maison forestière avait brûlé depuis l'aube » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.UNMARKED_CORRECTION],
  },
  {
    label: "silent mode accepts the unbracketed fix",
    md: `« la maison forestière avait brûlé depuis l'aube » ${CITE(1)}`,
    cited: 1,
    marking: "silent",
    expect: "ok",
    fuzzy: 1,
  },
  {
    label: "répu\\nblique → république passes (line-split merge)",
    md: `« le feu gagnait la république voisine » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
    fuzzy: 0,
  },
  {
    label: "[illisible] over the garbled run passes",
    md: `« ce vaste [illisible] n'est plus qu'un amas de ruines fumantes » ${CITE(2)}`,
    cited: 2,
    expect: "ok",
  },
  {
    label: "a 2-word gap inside a sentence passes",
    md: `« Le maire a déclaré […] que la ma:son forestière avait brûlé » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
  },
  {
    label: "a gap across one sentence boundary passes (adjacent sentences)",
    md: `« Première phrase du rapport […] Deuxième phrase du rapport » ${CITE(5)}`,
    cited: 5,
    expect: "ok",
  },
  {
    label: "a 60-word gap is elision_too_far",
    md: `« Début de la phrase […] fin de la phrase » ${CITE(4)}`,
    cited: 4,
    expect: [QUOTE_WARNING_REASON.ELISION_TOO_FAR],
  },
  {
    label: "a gap across a paragraph break is elision_too_far",
    md: `« Rien n'est encore établi […] un court-circuit a provoqué le sinistre » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.ELISION_TOO_FAR],
  },
  {
    label: "two sentence boundaries in the gap is elision_too_far",
    md: `« Première phrase du rapport […] Troisième phrase du rapport ici même » ${CITE(5)}`,
    cited: 5,
    expect: [QUOTE_WARNING_REASON.ELISION_TOO_FAR],
  },
  {
    label: "folio 1 → folio 3 is elision_across_folios",
    md: `« Les premiers témoins accusent l'imprudence du personnel […] Le conseil municipal se réunira demain » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS],
  },
  {
    label: "reversed segments are elision_out_of_order",
    md: `« un court-circuit a provoqué le sinistre […] Les premiers témoins accusent l'imprudence » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER],
  },
  {
    label: "a completed garbled run on a low folio is never ok",
    md: `« le Palais de Cristal, ce vaste édifice de verre et de fer, n'est plus qu'un amas » ${CITE(2)}`,
    cited: 2,
    low: [2],
    expect: [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO],
  },
  {
    label: "a bracketed correction on a low folio is correction_on_low_ocr",
    md: `« n'est plus qu'un amas de [ruines] fumantes » ${CITE(2)}`,
    cited: 2,
    low: [2],
    expect: [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR],
  },
  {
    label: "[illisible] on a low folio is not a correction",
    md: `« ce vaste [illisible] n'est plus qu'un amas de ruines fumantes » ${CITE(2)}`,
    cited: 2,
    low: [2],
    expect: "ok",
  },
  {
    label: "the correct text on folio 7 cited as folio 2 is found_on_other_folio 7",
    md: `« Nous ne reviendrons pas sur les causes exactes de cet incendie » ${CITE(2)}`,
    cited: 2,
    expect: [QUOTE_WARNING_REASON.FOUND_ON_OTHER_FOLIO],
    foundOnFolio: 7,
  },
  {
    label: "text absent from the whole document is not_in_cited_folio",
    md: `« Les pompiers de Calais sont arrivés en renfort vers minuit » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO],
  },
  {
    label: "more than two elisions is too_many_elisions",
    md: `« Le maire […] a déclaré […] hier soir […] que la ma:son forestière avait brûlé » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.TOO_MANY_ELISIONS],
  },
  {
    label: "(…) is nonstandard_elision_marker (and still an elision)",
    md: `« Le maire a déclaré (…) que la ma:son forestière avait brûlé » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER],
  },
  {
    label: "a quote that opens right after an elided qu' passes (« … qu'« un amas … »)",
    md: `« un amas de ruines fumantes » ${CITE(2)}`,
    cited: 2,
    expect: "ok",
    fuzzy: 0,
  },
  {
    label: "a segment after […] may also open after an elided article",
    md: `« Les premiers témoins accusent […] imprudence du personnel des cuisines » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
  },
  {
    label: "dropping an elided article INSIDE a quote is still a change",
    md: `« Les premiers témoins accusent imprudence du personnel des cuisines » ${CITE(1)}`,
    cited: 1,
    expect: [QUOTE_WARNING_REASON.UNMARKED_CORRECTION],
  },
  {
    label: "a quote that runs across the page break without an elision passes",
    md: `« un court-circuit a provoqué le sinistre le Palais de Cr#stal » ${CITE(1)}`,
    cited: 1,
    expect: "ok",
  },
]

for (const row of ROWS) {
  test(row.label, () => {
    const quotes = extractQuotes(row.md)
    assert.equal(quotes.length, 1, "one quote extracted")
    const verdicts: QuoteVerdict[] = verifyQuote(quotes[0], DOC, {
      citedFolio: row.cited,
      marking: row.marking ?? OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD,
      lowOcrFolios: new Set(row.low ?? []),
    })
    if (row.expect === "ok") {
      assert.deepEqual(
        verdicts.map((v) => (v.ok ? "ok" : v.reason)),
        ["ok"],
        JSON.stringify(verdicts),
      )
      const v = verdicts[0]
      if (v.ok && row.fuzzy !== undefined) assert.equal(v.fuzzyTokens, row.fuzzy)
      return
    }
    const reasons = verdicts.map((v) => (v.ok ? "ok" : v.reason))
    assert.deepEqual(reasons, row.expect, JSON.stringify(verdicts))
    if (row.foundOnFolio !== undefined) {
      const v = verdicts[0]
      assert.ok(!v.ok)
      assert.equal(v.foundOnFolio, row.foundOnFolio)
    }
  })
}

test("tokenizeFolios marks paragraph breaks and sentence ends, and joins printed hyphenation", () => {
  const doc = tokenizeFolios(new Map([[1, "La répu-\nblique est une. Elle vit.\n\nNouveau paragraphe ici."]]))
  const norms = doc.map((t) => t.norm)
  assert.deepEqual(norms, ["la", "république", "est", "une", "elle", "vit", "nouveau", "paragraphe", "ici"])
  assert.equal(doc[3].sentenceEndAfter, true, "'une.' ends a sentence before 'Elle'")
  assert.equal(doc[5].sentenceEndAfter, true, "'vit.' ends a sentence before 'Nouveau'")
  assert.equal(doc[6].paragraphBreakBefore, true, "a blank line precedes 'Nouveau'")
  assert.equal(doc[2].paragraphBreakBefore, false)
  assert.ok(doc.every((t) => t.folio === 1))
})

test("verifyQuote returns every applicable reason in one run", () => {
  const md = `« Le maire (…) a déclaré […] hier soir […] que la maison forestière avait brûlé » ${CITE(1)}`
  const q = extractQuotes(md)[0]
  const reasons = verifyQuote(q, DOC, {
    citedFolio: 1,
    marking: OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD,
    lowOcrFolios: new Set(),
  }).map((v) => (v.ok ? "ok" : v.reason))
  assert.ok(reasons.includes(QUOTE_WARNING_REASON.TOO_MANY_ELISIONS))
  assert.ok(reasons.includes(QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER))
  assert.ok(reasons.includes(QUOTE_WARNING_REASON.UNMARKED_CORRECTION))
  assert.ok(!reasons.includes("ok"))
})
