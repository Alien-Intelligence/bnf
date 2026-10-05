// tests/api/buffer-filters.test.ts
// The buffer filters have ONE definition (bufferFilterSetSchema,
// models/buffer/types.ts) shared by the agent tools and the REST route; the
// route decodes its query string into that shape (bufferFilterInputFromParams)
// and the client hook encodes it (bufferFiltersToParams). Found bugs this pins:
// `z.coerce.boolean()` turned the string "false" into `true`, so
// `?undated=false` returned the UNDATED candidates; and the REST schema, a
// second copy, had drifted (no `not`, no `unresolved`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { bufferFilterInputFromParams, bufferFiltersToParams } from "@/lib/buffer/filter-query"
import { bufferFilterSetSchema, type BufferFilterSet } from "@/models/buffer/types"

const parseQs = (qs: string) => bufferFilterSetSchema.safeParse(bufferFilterInputFromParams(new URLSearchParams(qs)))

test("booleans: false/0 are false, true/1 are true, anything else is refused", () => {
  for (const [qs, expected] of [
    ["undated=false", false],
    ["undated=0", false],
    ["undated=true", true],
    ["undated=1", true],
  ] as const) {
    const parsed = parseQs(qs)
    assert.ok(parsed.success, qs)
    assert.equal(parsed.data.undated, expected, qs)
  }
  assert.equal(parseQs("undated=yes").success, false)
  assert.equal(parseQs("unresolved=maybe").success, false)
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
  const parsed = bufferFilterSetSchema.safeParse(bufferFilterInputFromParams(params))
  assert.ok(parsed.success)
  assert.deepEqual(parsed.data, {
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
  assert.equal(parseQs("kind=pamphlet").success, false, "unknown record kind")
  assert.equal(parseQs("yearFrom=abc").success, false, "non-numeric year")
  assert.equal(parseQs("title=a").success, false, "a one-letter text criterion")
  assert.equal(parseQs("type=presse").success, false, "a type outside the vocabulary")
  assert.equal(parseQs("not.type=presse").success, false, "even under not")
  assert.equal(parseQs("lang=ger").success, false, "a non-canonical language code")
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
  const parsed = parseQs(bufferFiltersToParams(filters).toString())
  assert.ok(parsed.success)
  assert.deepEqual(parsed.data, filters)
})
