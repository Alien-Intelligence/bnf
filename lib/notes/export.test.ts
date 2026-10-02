// lib/notes/export.test.ts
// The low-OCR disclaimer in every Markdown export (feedback 2026-09-29 #7,
// Track B, plan D13): a note citing at least one low folio carries BnF's text
// as a blockquote under its title, and each low citation carries a marker
// after its Gallica link. A note with no low citation must export
// byte-identically to the 0.18.1 export — the regression guard below pins the
// exact pre-feature output.
import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_SOURCE } from "@/models/documents/schema"

import { noteToMarkdown, notesToMarkdown, type ExportCopy } from "./export"

const ARK = "ark:/12148/bpt6k4625753w"
const COPY: ExportCopy = { disclaimer: "AVERTISSEMENT BNF", lowMarker: "(qualité OCR faible)" }

const F1 = { ark: ARK, folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.932, wordCount: 5106 }
const F2 = { ark: ARK, folio: 2, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.661, wordCount: 4016 }

const BODY = `Le vélo [[${ARK}|L'Auto-vélo, 2 juillet 1910|1]] et la course [[${ARK}|L'Auto-vélo|2]].`

test("noteToMarkdown: no low citation → byte-identical to the 0.18.1 export", () => {
  const note = { title: "Le Tour", body_md: BODY, folioOcr: [F1] }
  assert.equal(
    noteToMarkdown(note, COPY),
    "# Le Tour\n\n" +
      "Le vélo [L'Auto-vélo, 2 juillet 1910](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)" +
      " et la course [L'Auto-vélo](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item).\n",
  )
})

test("noteToMarkdown: no stored quality at all → byte-identical too", () => {
  const withOcr = noteToMarkdown({ title: "Le Tour", body_md: BODY, folioOcr: [] }, COPY)
  assert.ok(!withOcr.includes(COPY.disclaimer))
  assert.ok(!withOcr.includes(COPY.lowMarker))
})

test("noteToMarkdown: f2 low → disclaimer under the title, marker after the f2 link only", () => {
  const md = noteToMarkdown({ title: "Le Tour", body_md: BODY, folioOcr: [F1, F2] }, COPY)
  assert.equal(
    md,
    "# Le Tour\n\n" +
      "> AVERTISSEMENT BNF\n\n" +
      "Le vélo [L'Auto-vélo, 2 juillet 1910](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)" +
      " et la course [L'Auto-vélo](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item) (qualité OCR faible).\n",
  )
})

test("noteToMarkdown: an image embed of a low folio never triggers it (D11)", () => {
  const md = noteToMarkdown(
    { title: "Image", body_md: `![[${ARK}|Une|2]]`, folioOcr: [F2] },
    COPY,
  )
  assert.ok(!md.includes(COPY.disclaimer))
  assert.ok(!md.includes(COPY.lowMarker))
})

test("notesToMarkdown: one disclaimer per affected note section", () => {
  const md = notesToMarkdown(
    [
      { title: "A", body_md: `[[${ARK}|A|2]]`, folioOcr: [F2] },
      { title: "B", body_md: `[[${ARK}|B|1]]`, folioOcr: [F1] },
      { title: "C", body_md: `[[${ARK}|C|2]] [[${ARK}|C|f2]]`, folioOcr: [F2] },
    ],
    COPY,
  )
  const sections = md.split("\n---\n\n")
  assert.equal(sections.length, 3)
  assert.ok(sections[0].startsWith("## A\n\n> AVERTISSEMENT BNF\n\n"))
  assert.ok(!sections[1].includes(COPY.disclaimer))
  assert.equal(sections[2].split(COPY.disclaimer).length - 1, 1, "one banner even with two low cites")
  assert.equal(sections[2].split(COPY.lowMarker).length - 1, 2, "a marker on each low cite")
})

test("notesToMarkdown: nothing low → byte-identical to the 0.18.1 export", () => {
  assert.equal(
    notesToMarkdown(
      [
        { title: "A", body_md: `[[${ARK}|A|1]]`, folioOcr: [F1] },
        { title: "B", body_md: null, folioOcr: [] },
      ],
      COPY,
    ),
    "## A\n\n[A](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)\n" +
      "\n---\n\n" +
      "## B\n\n\n",
  )
})
