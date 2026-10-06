// lib/mcp/normalize.test.ts
// parseBnfDate — the one parser every BnF date goes through, for Document rows
// (normalizeDocument) and buffer rows (corpus_search). Found bug (Track E):
// Gallica dates a press ISSUE as a full ISO date ("1937-07-12"), which matched
// no rule and fell to "unparseable": year null, so every issue was invisible
// to year filters and the period histogram (1 249 of 1 249 such documents on
// the track DB).
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseBnfDate } from "./normalize"

test("a full ISO date (a press issue) gives its year and keeps the date as label", () => {
  assert.deepEqual(parseBnfDate("1937-07-12"), { year: 1937, label: "1937-07-12" })
  assert.deepEqual(parseBnfDate("1955-03"), { year: 1955, label: "1955-03" })
})

test("the existing rules are unchanged", () => {
  assert.deepEqual(parseBnfDate(null), { year: null, label: null })
  assert.deepEqual(parseBnfDate("  "), { year: null, label: null })
  assert.deepEqual(parseBnfDate("1862"), { year: 1862, label: null })
  assert.deepEqual(parseBnfDate("vers 1890"), { year: 1890, label: "vers 1890" })
  assert.deepEqual(parseBnfDate("1850-1860"), { year: 1850, label: "1850–1860" })
  assert.deepEqual(parseBnfDate("XIXe siècle"), { year: null, label: "XIXe siècle" })
  assert.deepEqual(parseBnfDate("s.d."), { year: null, label: "s.d." })
})
