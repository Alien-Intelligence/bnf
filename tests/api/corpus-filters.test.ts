// tests/api/corpus-filters.test.ts
// The corpus filters' REST boundary: GET /corpus and GET /corpus/export decode
// their query string (lib/corpus/filter-query.ts) into the ONE corpus filter
// schema the agent tools use (models/corpus/types.ts). Pinned here: whatever
// the Constituer panel writes into the URL reads back the same; `undated` is
// parsed strictly (the coerced "false" used to filter TO undated documents);
// the full agent vocabulary (not, title, creator, kind) is accepted; and an
// invalid value is refused, never dropped.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { corpusFilterInputFromParams } from "@/lib/corpus/filter-query"
import { corpusFilterSetSchema, corpusFiltersToParams } from "@/models/corpus/types"

const parse = (params: URLSearchParams) => {
  const input = corpusFilterInputFromParams(params)
  return input === undefined ? undefined : corpusFilterSetSchema.safeParse(input)
}

test("no filter parameter → undefined (an unfiltered read), not an empty object", () => {
  assert.equal(corpusFilterInputFromParams(new URLSearchParams("version=head&limit=5")), undefined)
})

test("the panel's comma-joined multi-selects become arrays; whitespace and empties dropped", () => {
  const parsed = parse(new URLSearchParams("type=%20book%20,%20press%20,,%20"))
  assert.ok(parsed?.success)
  assert.deepEqual(parsed.data.type, ["book", "press"])
  assert.equal(corpusFilterInputFromParams(new URLSearchParams("type=%20,%20,%20")), undefined)
})

test("every dimension the panel writes reads back the same", () => {
  const ui = {
    type: "book",
    lang: "fr",
    source: "gallica",
    session: "11111111-1111-4111-8111-111111111111",
    ingest: "ocr,vision",
    outcome: "failed",
    yearFrom: 1880,
    yearTo: 1890,
    undated: false,
    q: "incendie",
  }
  const parsed = parse(corpusFiltersToParams(ui))
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
  for (const qs of ["type=presse", "lang=ger", "source=bnf", "kind=pamphlet", "ingest=scan", "yearFrom=abc"]) {
    assert.equal(parse(new URLSearchParams(qs))?.success, false, qs)
  }
})
