// lib/citations/syntax.test.ts
// The citation parser is strict on the folio: a IIIF vue index is ≥ 1.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCitations, parseImageCitations } from "./syntax"

const ARK = "ark:/12148/bpt6k2839841"

test("a citation with folio 0 is not a citation; folio 1 and f2 are", () => {
  const md = `a [[${ARK}|Le Figaro|0]] b [[${ARK}|Le Figaro|1]] c [[${ARK}|Le Figaro|f2]]`
  assert.deepEqual(parseCitations(md).map((c) => c.folio), [1, 2])
})

test("an image embed with folio 0 is not an embed", () => {
  assert.deepEqual(parseImageCitations(`![[${ARK}|Une|0]]`), [])
})
