// lib/cluster/folio-text.test.ts
// Contract test on the app side of the folio format worker-v2 writes. The
// CONTRACT sample — pages, markdown and code-point offsets — is the same
// literal that worker-v2/src/live/cluster.test.ts asserts `assembleMarkdown`
// and `buildIndexChunks` produce. If either side changes the format or the
// offset unit, one of the two tests goes red.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  EntryFolioFormatError,
  assembleEntryText,
  codePointLength,
  sliceCodePoints,
  splitEntryFolios,
} from "./folio-text"

// --- CONTRACT (keep identical to worker-v2/src/live/cluster.test.ts) ------
const CONTRACT_PAGES = [
  { folio: 5, text: "Texte folio 5" },
  { folio: 9, text: "  Le 𝔊 gothique — Œuvre\nsur deux lignes \n" },
  { folio: 10, text: "   " },
  { folio: 12, text: "Dernier 😀 mot" },
]
const CONTRACT_MARKDOWN =
  "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nLe 𝔊 gothique — Œuvre\nsur deux lignes" +
  "\n\n## Folio 10\n\n\n\n## Folio 12\n\nDernier 😀 mot"
/** `[char_start, char_end]` per page, in Unicode code points (Python `str` indices). */
const CONTRACT_OFFSETS: Array<[number, number]> = [
  [12, 25],
  [39, 76],
  [91, 91],
  [106, 119],
]
// ---------------------------------------------------------------------------

test("CONTRACT: assembleEntryText writes the worker's literal markdown and code-point offsets", () => {
  const { text, ranges } = assembleEntryText(CONTRACT_PAGES)
  assert.equal(text, CONTRACT_MARKDOWN)
  assert.deepEqual(ranges, CONTRACT_OFFSETS)
  assert.equal(codePointLength(CONTRACT_MARKDOWN), 119)
  assert.equal(CONTRACT_MARKDOWN.length, 121, "two astral characters: UTF-16 length differs")
  for (const [i, [start, end]] of CONTRACT_OFFSETS.entries()) {
    assert.equal(sliceCodePoints(CONTRACT_MARKDOWN, start, end), CONTRACT_PAGES[i].text.trim())
  }
})

test("CONTRACT: splitEntryFolios recovers every page of the literal sample", () => {
  assert.deepEqual([...splitEntryFolios(CONTRACT_MARKDOWN).entries()], [
    [5, "Texte folio 5"],
    [9, "Le 𝔊 gothique — Œuvre\nsur deux lignes"],
    [10, ""],
    [12, "Dernier 😀 mot"],
  ])
})

test("codePointLength counts a surrogate pair once and a lone surrogate once", () => {
  assert.equal(codePointLength("a😀b"), 3)
  assert.equal(codePointLength("\ud83d"), 1)
  assert.equal(codePointLength(""), 0)
})

test("a multi-line page keeps its inner blank lines and line breaks", () => {
  const md = "## Folio 1\n\nPremier paragraphe.\n\nSecond paragraphe\nsur deux lignes.\n\n## Folio 2\n\nSuite."
  const folios = splitEntryFolios(md)
  assert.equal(folios.get(1), "Premier paragraphe.\n\nSecond paragraphe\nsur deux lignes.")
  assert.equal(folios.get(2), "Suite.")
})

test("an out-of-order heading is page text, not a boundary", () => {
  const md = "## Folio 3\n\nabc\n\n## Folio 2\n\ndef"
  const folios = splitEntryFolios(md)
  assert.deepEqual([...folios.keys()], [3])
  assert.equal(folios.get(3), "abc\n\n## Folio 2\n\ndef")
})

test("a `## Folio n` inside page text, after a single newline, is not a boundary", () => {
  // Mistral-lane pages are Markdown: an OCR'd heading can read like ours.
  const md = "## Folio 3\n\nTitre de rubrique\n## Folio 7\n\nsuite de la page 3\n\n## Folio 4\n\nPage quatre."
  const folios = splitEntryFolios(md)
  assert.deepEqual([...folios.keys()], [3, 4])
  assert.equal(folios.get(3), "Titre de rubrique\n## Folio 7\n\nsuite de la page 3")
})

test("heading-free text throws a typed format error — not an entry this app wrote", () => {
  assert.throws(() => splitEntryFolios("Un texte sans aucun en-tête de folio."), EntryFolioFormatError)
  assert.throws(() => splitEntryFolios(""), EntryFolioFormatError)
})

test("text that does not open with a heading throws a typed format error", () => {
  assert.throws(() => splitEntryFolios("préambule\n\n## Folio 1\n\nTexte"), EntryFolioFormatError)
})

test("an empty page body yields an empty string, not an absent key", () => {
  // assembleMarkdown of [{5, ""}, {6, "x"}, {7, ""}]: the empty pages leave the
  // heading followed by the "\n\n" join (or by nothing, for the last page).
  const md = "## Folio 5\n\n\n\n## Folio 6\n\nx\n\n## Folio 7\n\n"
  const folios = splitEntryFolios(md)
  assert.deepEqual([...folios.entries()], [
    [5, ""],
    [6, "x"],
    [7, ""],
  ])
})
