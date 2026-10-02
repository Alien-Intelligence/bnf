// lib/notes/export.test.ts
// The low-OCR disclaimer in every Markdown export (feedback 2026-09-29 #7,
// Track B, plan D13): a note citing at least one MEASURED low folio carries
// BnF's text as a blockquote under its title, and each low citation carries a
// marker after its Gallica link. A note with no low citation — including one
// whose folios' quality is not available yet — must export byte-identically to
// the 0.18.1 export: the strings below are the exact pre-feature output.
import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_SOURCE, OCR_SYNC_STATUS } from "@/models/documents/schema"

import { noteToMarkdown, notesToMarkdown, type ExportCopy } from "./export"

const ARK = "ark:/12148/bpt6k4625753w"
const COPY: ExportCopy = { disclaimer: "AVERTISSEMENT BNF", lowMarker: "(qualité OCR faible)" }

const F1 = { ark: ARK, folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.932, wordCount: 5106 }
const F2 = { ark: ARK, folio: 2, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.661, wordCount: 4016 }
const SYNCED = [{ ark: ARK, status: OCR_SYNC_STATUS.AVAILABLE }]

const BODY = `Le vélo [[${ARK}|L'Auto-vélo, 2 juillet 1910|1]] et la course [[${ARK}|L'Auto-vélo|2]].`

/** The 0.18.1 export of BODY under the title "Le Tour" — pinned before the feature. */
const PLAIN_EXPORT =
  "# Le Tour\n\n" +
  "Le vélo [L'Auto-vélo, 2 juillet 1910](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)" +
  " et la course [L'Auto-vélo](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item).\n"

test("noteToMarkdown: no low citation → byte-identical to the 0.18.1 export", () => {
  // f2 is cited but its synced document has no row for it: not low, not marked.
  const note = { title: "Le Tour", body_md: BODY, folioOcr: [F1], documentOcr: SYNCED }
  assert.equal(noteToMarkdown(note, COPY), PLAIN_EXPORT)
})

test("noteToMarkdown: quality not synced yet → byte-identical too (unknown is never marked)", () => {
  assert.equal(
    noteToMarkdown({ title: "Le Tour", body_md: BODY, folioOcr: [], documentOcr: [] }, COPY),
    PLAIN_EXPORT,
  )
})

test("noteToMarkdown: f2 low → disclaimer under the title, marker after the f2 link only", () => {
  const md = noteToMarkdown(
    { title: "Le Tour", body_md: BODY, folioOcr: [F1, F2], documentOcr: SYNCED },
    COPY,
  )
  assert.equal(
    md,
    "# Le Tour\n\n" +
      "> AVERTISSEMENT BNF\n\n" +
      "Le vélo [L'Auto-vélo, 2 juillet 1910](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)" +
      " et la course [L'Auto-vélo](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item) (qualité OCR faible).\n",
  )
})

test("noteToMarkdown: an image embed of a low folio never triggers it (D11)", () => {
  assert.equal(
    noteToMarkdown(
      { title: "Image", body_md: `![[${ARK}|Une|2]]`, folioOcr: [F2], documentOcr: SYNCED },
      COPY,
    ),
    "# Image\n\n" +
      "[![Une](https://gallica.bnf.fr/iiif/ark:/12148/bpt6k4625753w/f2/full/full/0/native.jpg)]" +
      "(https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item)\n",
  )
})

test("notesToMarkdown: one disclaimer per affected note section", () => {
  const md = notesToMarkdown(
    [
      { title: "A", body_md: `[[${ARK}|A|2]]`, folioOcr: [F2], documentOcr: SYNCED },
      { title: "B", body_md: `[[${ARK}|B|1]]`, folioOcr: [F1], documentOcr: SYNCED },
      { title: "C", body_md: `[[${ARK}|C|2]] [[${ARK}|C|f2]]`, folioOcr: [F2], documentOcr: SYNCED },
    ],
    COPY,
  )
  assert.equal(
    md,
    "## A\n\n> AVERTISSEMENT BNF\n\n" +
      "[A](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item) (qualité OCR faible)\n" +
      "\n---\n\n" +
      "## B\n\n[B](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)\n" +
      "\n---\n\n" +
      "## C\n\n> AVERTISSEMENT BNF\n\n" +
      "[C](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item) (qualité OCR faible)" +
      " [C](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f2.item) (qualité OCR faible)\n",
  )
})

test("notesToMarkdown: nothing low → byte-identical to the 0.18.1 export", () => {
  assert.equal(
    notesToMarkdown(
      [
        { title: "A", body_md: `[[${ARK}|A|1]]`, folioOcr: [F1], documentOcr: SYNCED },
        { title: "B", body_md: null, folioOcr: [], documentOcr: [] },
      ],
      COPY,
    ),
    "## A\n\n[A](https://gallica.bnf.fr/ark:/12148/bpt6k4625753w/f1.item)\n" +
      "\n---\n\n" +
      "## B\n\n\n",
  )
})
