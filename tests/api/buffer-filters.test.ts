// tests/api/buffer-filters.test.ts
// The buffer filters have ONE definition (bufferFilterSetSchema,
// models/buffer/types.ts) shared by the agent tools and the REST route; the
// route reads its query string with the shared codec (lib/filter-query.ts,
// field list in lib/buffer/filter-query.ts) and the client hook encodes with
// it. Found bugs this pins: `z.coerce.boolean()` turned the string "false"
// into `true`; the REST schema, a second copy, had drifted; unknown keys were
// silently dropped (widening a removal); `Number()` read `0x10` as 16.
import { test } from "node:test"
import assert from "node:assert/strict"
import { bufferFilterQuery } from "@/lib/buffer/filter-query"
import { parseFilterParams } from "@/lib/filter-query"
import { bufferFilterSetSchema, type BufferFilterSet } from "@/models/buffer/types"

const ROUTE_PARAMS = ["limit"]
const read = (params: URLSearchParams) => parseFilterParams(bufferFilterQuery, bufferFilterSetSchema, params, ROUTE_PARAMS)
const readQs = (qs: string) => read(new URLSearchParams(qs))
const ok = (qs: string) => {
  const r = readQs(qs)
  if (!r.ok) throw new Error(`${qs} refused: ${r.error}`)
  return r.filters
}

test("booleans: false/0 are false, true/1 are true, anything else is refused", () => {
  for (const [qs, expected] of [
    ["undated=false", false],
    ["undated=0", false],
    ["undated=true", true],
    ["undated=1", true],
  ] as const) {
    assert.equal(ok(qs)?.undated, expected, qs)
  }
  assert.equal(readQs("undated=yes").ok, false)
  assert.equal(readQs("unresolved=maybe").ok, false)
})

test("coded lists accept repeats or commas; free-text lists are repeated and keep their commas", () => {
  const params = new URLSearchParams(
    "type=press,%20book&kind=periodical_issue&yearFrom=1937&unresolved=false&not.lang=fr&limit=50",
  )
  params.append("title", "Oran")
  params.append("title", "Alger")
  params.append("creator", "Hugo, Victor")
  params.append("subject", "Incendies")
  params.append("not.title", "Mers-el-Kébir")
  const r = read(params)
  assert.ok(r.ok)
  assert.deepEqual(r.filters, {
    type: ["press", "book"],
    kind: ["periodical_issue"],
    title: ["Oran", "Alger"],
    creator: ["Hugo, Victor"],
    subject: ["Incendies"],
    yearFrom: 1937,
    unresolved: false,
    not: { lang: ["fr"], title: ["Mers-el-Kébir"] },
  })
})

test("invalid values are refused, not dropped", () => {
  for (const qs of ["kind=pamphlet", "yearFrom=abc", "title=a", "type=presse", "not.type=presse", "lang=FR"]) {
    assert.equal(readQs(qs).ok, false, qs)
  }
})

test("integers are digits only: hex, exponent and decimals are refused, not read as numbers", () => {
  for (const qs of ["yearFrom=0x10", "yearFrom=1e3", "yearTo=12.5", "yearFrom=%20"]) {
    assert.equal(readQs(qs).ok, false, qs)
  }
  assert.equal(ok("yearFrom=-50")?.yearFrom, -50)
})

test("an unknown parameter is refused with a message, never dropped (it would widen a removal)", () => {
  for (const qs of ["langs=fr", "not.not.type=press", "session=11111111-1111-4111-8111-111111111111"]) {
    const r = readQs(qs)
    assert.equal(r.ok, false, qs)
    assert.ok(!r.ok && /inconnu/.test(r.error), qs)
  }
  assert.equal(readQs("limit=5").ok, true, "the route's own parameter is not a filter")
})

test("the schema is strict at both levels: unknown keys from the agent are refused too", () => {
  assert.equal(bufferFilterSetSchema.safeParse({ langs: ["fr"] }).success, false)
  assert.equal(bufferFilterSetSchema.safeParse({ not: { not: { type: ["press"] } } }).success, false)
})

test("encoding then decoding returns the same filter set", () => {
  const filters: BufferFilterSet = {
    type: ["press"],
    kind: ["monograph", "image"],
    yearFrom: 1880,
    yearTo: 1890,
    undated: true,
    q: "incendie",
    creator: ["Hugo, Victor"],
    not: { lang: ["fr"], unresolved: true },
  }
  const r = read(bufferFilterQuery.encode(filters))
  assert.ok(r.ok)
  assert.deepEqual(r.filters, filters)
})
