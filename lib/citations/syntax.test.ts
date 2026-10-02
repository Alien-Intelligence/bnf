// lib/citations/syntax.test.ts
// The citation parser is strict on the folio: a IIIF vue index is ≥ 1.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CITATION_REGEX,
  IMAGE_CITATION_REGEX,
  findInvalidFolioCitations,
  parseCitations,
  parseImageCitations,
} from "./syntax"

const ARK = "ark:/12148/bpt6k2839841"

test("a citation with folio 0 is not a citation; folio 1 and f2 are", () => {
  const md = `a [[${ARK}|Le Figaro|0]] b [[${ARK}|Le Figaro|1]] c [[${ARK}|Le Figaro|f2]]`
  assert.deepEqual(parseCitations(md).map((c) => c.folio), [1, 2])
})

test("an image embed with folio 0 is not an embed", () => {
  assert.deepEqual(parseImageCitations(`![[${ARK}|Une|0]]`), [])
})

test("the regexes themselves reject folio 0, so every scanner agrees with the parser", () => {
  // note-body.tsx numbers its carriers with CITATION_REGEX and resolves them
  // with parseCitations(): the two must see the same citations.
  const md = `[[${ARK}|A|0]] [[${ARK}|B|3]] ![[${ARK}|C|0]] ![[${ARK}|D|4]]`
  assert.deepEqual([...md.matchAll(CITATION_REGEX)].map((m) => m[3]), ["3"])
  assert.deepEqual([...md.matchAll(IMAGE_CITATION_REGEX)].map((m) => m[3]), ["4"])
})

test("a folio is a safe integer by construction: 15 significant digits at most, leading zeros tolerated", () => {
  const ok = `[[${ARK}|A|007]] [[${ARK}|B|999999999999999]]`
  assert.deepEqual(parseCitations(ok).map((c) => c.folio), [7, 999_999_999_999_999])
  assert.ok(parseCitations(ok).every((c) => Number.isSafeInteger(c.folio)))
  assert.deepEqual(parseCitations(`[[${ARK}|A|99999999999999999999]]`), [])
})

test("findInvalidFolioCitations reports what the strict syntax rejected for its folio", () => {
  const md = `[[${ARK}|A|0]] [[${ARK}|B|2]] ![[${ARK}|C|00]] [[${ARK}|D|99999999999999999999]]`
  assert.deepEqual(
    findInvalidFolioCitations(md).map((c) => c.folio),
    ["0", "00", "99999999999999999999"],
  )
})
