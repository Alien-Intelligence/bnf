// tests/api/corpus-filters.test.ts
// The corpus filters' URL boundary: GET /corpus, GET /corpus/export AND the
// Constituer page read their query string with the shared codec
// (lib/filter-query.ts parseFilterParams, field list in
// lib/corpus/filter-query.ts) into the ONE corpus filter schema the agent tools
// use (models/corpus/types.ts) — there is no second, CSV-shaped client schema.
// Pinned here: whatever the panel writes reads back the same; `undated` is
// parsed strictly; the full agent vocabulary is accepted; an invalid value or
// an unknown parameter is refused, never dropped; a refused URL is a result,
// never a throw (the page render used to crash on `.parse`).
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { corpusFilterQuery } from "@/lib/corpus/filter-query"
import { patchFilters, toggleFilterValue } from "@/lib/corpus/filter-state"
import { parseFilterParams } from "@/lib/filter-query"
import { corpusFilterSetSchema, type CorpusFilterSet } from "@/models/corpus/types"

const ROUTE_PARAMS = ["version", "cursor", "limit", "selectedArk"]
const read = (params: URLSearchParams) =>
  parseFilterParams(corpusFilterQuery, corpusFilterSetSchema, params, ROUTE_PARAMS)
/** The old shape of these tests: undefined for no filter, else a safeParse-like result. */
const parse = (params: URLSearchParams) => {
  const r = read(params)
  if (!r.ok) return { success: false as const }
  return r.filters === undefined ? undefined : { success: true as const, data: r.filters }
}

test("no filter parameter → undefined (an unfiltered read), not an empty object", () => {
  const r = read(new URLSearchParams("version=head&limit=5"))
  assert.ok(r.ok)
  assert.equal(r.filters, undefined)
})

test("the panel's comma-joined multi-selects become arrays; whitespace and empties dropped", () => {
  const parsed = parse(new URLSearchParams("type=%20book%20,%20press%20,,%20"))
  assert.ok(parsed?.success)
  assert.deepEqual(parsed.data.type, ["book", "press"])
  assert.equal(parse(new URLSearchParams("type=%20,%20,%20")), undefined)
})

test("every dimension the panel writes reads back the same", () => {
  let ui: CorpusFilterSet = {}
  ui = toggleFilterValue(ui, "type", "book")
  ui = toggleFilterValue(ui, "lang", "fr")
  ui = toggleFilterValue(ui, "source", "gallica")
  ui = toggleFilterValue(ui, "session", "11111111-1111-4111-8111-111111111111")
  ui = toggleFilterValue(ui, "ingest", "ocr")
  ui = toggleFilterValue(ui, "ingest", "vision")
  ui = toggleFilterValue(ui, "outcome", "failed")
  ui = patchFilters(ui, { yearFrom: 1880, yearTo: 1890, undated: false, q: "incendie" })
  const parsed = parse(corpusFilterQuery.encode(ui))
  assert.ok(parsed?.success)
  assert.deepEqual(parsed.data, {
    type: ["book"],
    lang: ["fr"],
    source: ["gallica"],
    session: ["11111111-1111-4111-8111-111111111111"],
    ingest: ["ocr", "vision"],
    outcome: ["failed"],
    yearFrom: 1880,
    yearTo: 1890,
    undated: false,
    q: "incendie",
  })
})

test("a URL the schema refuses is a result the page shows, never a throw", () => {
  for (const qs of ["undated=yes", "yearFrom=abc", "langs=fr", "not.session=11111111-1111-4111-8111-111111111111"]) {
    const r = read(new URLSearchParams(qs))
    assert.equal(r.ok, false, qs)
    assert.ok(!r.ok && r.error.length > 0, `${qs} carries a message`)
  }
})

test("integers are digits only: 0x10 and 1e3 are refused, not read as 16 and 1000", () => {
  for (const qs of ["yearFrom=0x10", "yearTo=1e3", "yearFrom=19.5"]) {
    assert.equal(parse(new URLSearchParams(qs))?.success, false, qs)
  }
})

test("the panel cannot hold a set the server would refuse: an off-vocabulary toggle is refused", () => {
  assert.deepEqual(toggleFilterValue({}, "type", "presse"), {})
})

test("undated is strict: false is false, garbage is refused", () => {
  assert.equal(parse(new URLSearchParams("undated=false"))?.success && parse(new URLSearchParams("undated=false"))?.data?.undated, false)
  assert.equal(parse(new URLSearchParams("undated=1"))?.data?.undated, true)
  assert.equal(parse(new URLSearchParams("undated=yes"))?.success, false)
})

test("the agent's vocabulary is accepted at REST too; free-text keeps its commas", () => {
  const params = new URLSearchParams()
  params.append("creator", "Hugo, Victor")
  params.append("title", "Oran")
  params.append("kind", "periodical_issue")
  params.append("not.lang", "fr")
  const parsed = parse(params)
  assert.ok(parsed?.success)
  assert.deepEqual(parsed.data, {
    creator: ["Hugo, Victor"],
    title: ["Oran"],
    kind: ["periodical_issue"],
    not: { lang: ["fr"] },
  })
})

test("values outside the vocabulary are refused, not dropped", () => {
  for (const qs of ["type=presse", "lang=FR", "source=bnf", "kind=pamphlet", "ingest=scan", "yearFrom=abc"]) {
    assert.equal(parse(new URLSearchParams(qs))?.success, false, qs)
  }
})
