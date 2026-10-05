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
  FolioMapAmbiguousError,
  assembleEntryText,
  codePointLength,
  escapeFolioHeadings,
  foliosFromChunks,
  sliceCodePoints,
  splitEntryFolios,
  unescapeFolioHeadings,
} from "./folio-text"

// --- CONTRACT (keep identical to worker-v2/src/live/cluster.test.ts) ------
const CONTRACT_PAGES = [
  { folio: 5, text: "Texte folio 5" },
  { folio: 9, text: "  Le 𝔊 gothique — Œuvre\nsur deux lignes \n" },
  { folio: 10, text: "   " },
  { folio: 12, text: "Dernier 😀 mot" },
  // Page text holding heading-shaped lines (one already backslashed): the
  // worker escapes them, so they can never read as a boundary.
  { folio: 14, text: "Rubrique\n\n## Folio 40\n\nsuite\n\\## Folio 2" },
]
const CONTRACT_MARKDOWN =
  "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nLe 𝔊 gothique — Œuvre\nsur deux lignes" +
  "\n\n## Folio 10\n\n\n\n## Folio 12\n\nDernier 😀 mot" +
  "\n\n## Folio 14\n\nRubrique\n\n\\## Folio 40\n\nsuite\n\\\\## Folio 2"
/** `[char_start, char_end]` per page, in Unicode code points (Python `str` indices). */
const CONTRACT_OFFSETS: Array<[number, number]> = [
  [12, 25],
  [39, 76],
  [91, 91],
  [106, 119],
  [134, 176],
]
// ---------------------------------------------------------------------------

test("CONTRACT: assembleEntryText writes the worker's literal markdown and code-point offsets", () => {
  const { text, ranges } = assembleEntryText(CONTRACT_PAGES)
  assert.equal(text, CONTRACT_MARKDOWN)
  assert.deepEqual(ranges, CONTRACT_OFFSETS)
  assert.equal(codePointLength(CONTRACT_MARKDOWN), 176)
  assert.equal(CONTRACT_MARKDOWN.length, 178, "two astral characters: UTF-16 length differs")
  for (const [i, [start, end]] of CONTRACT_OFFSETS.entries()) {
    assert.equal(sliceCodePoints(CONTRACT_MARKDOWN, start, end), escapeFolioHeadings(CONTRACT_PAGES[i].text.trim()))
  }
})

/** The chunks the worker indexes for the CONTRACT sample: one per page, with its range. */
const CONTRACT_CHUNKS = CONTRACT_PAGES.map((p, i) => ({
  folio: p.folio,
  charStart: CONTRACT_OFFSETS[i][0],
  charEnd: CONTRACT_OFFSETS[i][1],
  text: escapeFolioHeadings(p.text.trim()),
}))

const CONTRACT_FOLIOS: Array<[number, string]> = [
  [5, "Texte folio 5"],
  [9, "Le 𝔊 gothique — Œuvre\nsur deux lignes"],
  [10, ""],
  [12, "Dernier 😀 mot"],
  [14, "Rubrique\n\n## Folio 40\n\nsuite\n\\## Folio 2"],
]

test("CONTRACT: the chunks' ranges give the folio map, page text unescaped", () => {
  const folios = foliosFromChunks(CONTRACT_MARKDOWN, CONTRACT_CHUNKS)
  assert.ok(folios)
  assert.deepEqual([...folios.entries()], CONTRACT_FOLIOS)
})

test("CONTRACT: the heading fallback reads the escaped sample the same way", () => {
  assert.deepEqual([...splitEntryFolios(CONTRACT_MARKDOWN).entries()], CONTRACT_FOLIOS)
})

test("escaping is reversible, one backslash at a time", () => {
  for (const t of ["## Folio 4", "\\## Folio 4", "\\\\## Folio 4", "a\n## Folio 4\nb", "## Folio x", "texte ## Folio 4"]) {
    assert.equal(unescapeFolioHeadings(escapeFolioHeadings(t)), t)
  }
})

test("chunks that do not tile the worker's format are not trusted (null → heading fallback)", () => {
  const shifted = CONTRACT_CHUNKS.map((c) => ({ ...c, charStart: c.charStart + 1 }))
  assert.equal(foliosFromChunks(CONTRACT_MARKDOWN, shifted), null)
  assert.equal(foliosFromChunks(CONTRACT_MARKDOWN, CONTRACT_CHUNKS.slice(0, 4)), null, "a missing last page")
  assert.equal(foliosFromChunks(CONTRACT_MARKDOWN, CONTRACT_CHUNKS.filter((c) => c.folio !== 9)), null, "a gap")
  const relabelled = CONTRACT_CHUNKS.map((c) => (c.folio === 9 ? { ...c, folio: 11 } : c))
  assert.equal(foliosFromChunks(CONTRACT_MARKDOWN, relabelled), null, "a folio that its heading contradicts")
  assert.equal(foliosFromChunks(CONTRACT_MARKDOWN, []), null)
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

test("fallback: an out-of-order heading makes the map ambiguous, never a guess", () => {
  assert.throws(() => splitEntryFolios("## Folio 3\n\nabc\n\n## Folio 2\n\ndef"), FolioMapAmbiguousError)
  // The pass-3 probe: page 3 holds "## Folio 40", the real 4–39 follow.
  const pages = Array.from({ length: 36 }, (_, i) => `## Folio ${i + 4}\n\nPage ${i + 4}.`).join("\n\n")
  assert.throws(
    () => splitEntryFolios(`## Folio 3\n\nRubrique\n\n## Folio 40\n\nsuite\n\n${pages}`),
    FolioMapAmbiguousError,
  )
})

test("fallback: a `## Folio n` after a single newline is page text", () => {
  const md = "## Folio 3\n\nTitre de rubrique\n## Folio 7\n\nsuite de la page 3\n\n## Folio 4\n\nPage quatre."
  assert.deepEqual([...splitEntryFolios(md).keys()], [3, 4])
})

test("fallback: the documented legacy header is dropped; any other prefix is ambiguous", () => {
  const header =
    "# Viaduc de Garabit\n\n**Auteur·rice :** Terpereau  \n**Date :** 1883  \n**Pages :** 1\n\n"
  assert.deepEqual(
    [...splitEntryFolios(`${header}## Folio 1\n\n### Type visuel\nphotographie`).entries()],
    [[1, "### Type visuel\nphotographie"]],
  )
  for (const prefix of ["préambule libre\n\n", "# \n\nGARBAGE\n\n", "# Titre\n\ntexte libre\n\n"]) {
    assert.throws(() => splitEntryFolios(`${prefix}## Folio 1\n\nTexte`), FolioMapAmbiguousError, JSON.stringify(prefix))
  }
})

test("heading-free text throws a typed format error — not an entry this app wrote", () => {
  assert.throws(() => splitEntryFolios("Un texte sans aucun en-tête de folio."), EntryFolioFormatError)
  assert.throws(() => splitEntryFolios(""), EntryFolioFormatError)
})

test("an empty page body yields an empty string, not an absent key", () => {
  const md = "## Folio 5\n\n\n\n## Folio 6\n\nx\n\n## Folio 7\n\n"
  assert.deepEqual([...splitEntryFolios(md).entries()], [
    [5, ""],
    [6, "x"],
    [7, ""],
  ])
})
