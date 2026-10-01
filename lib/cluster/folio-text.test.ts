// lib/cluster/folio-text.test.ts
// Contract test on the app side of the folio format worker-v2 writes. The
// literal sample here is the same one worker-v2/src/live/cluster.test.ts
// asserts assembleMarkdown produces — if either side changes the format, one
// of the two tests goes red.
import { test } from "node:test"
import assert from "node:assert/strict"
import { splitEntryFolios } from "./folio-text"

test("a literal worker-format sample splits into folio → page text", () => {
  const md = "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nTexte folio 9"
  const folios = splitEntryFolios(md)
  assert.deepEqual([...folios.entries()], [
    [5, "Texte folio 5"],
    [9, "Texte folio 9"],
  ])
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

test("heading-free text throws — not an entry this app wrote", () => {
  assert.throws(() => splitEntryFolios("Un texte sans aucun en-tête de folio."), /Folio/)
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
