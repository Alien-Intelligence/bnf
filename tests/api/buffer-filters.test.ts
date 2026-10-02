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
import { bufferFilterInputFromParams, bufferFilterSetSchema, bufferFiltersToParams } from "@/models/buffer/types"
import type { BufferFilterSet } from "@/models/buffer/schema"

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

test("CSV lists become arrays; not.<field> becomes the exclusion; unresolved is accepted", () => {
  const parsed = parseQs(
    "type=press,%20book&kind=periodical_issue&title=Oran,Alger,&creator=Hugo&subject=Incendies" +
      "&yearFrom=1937&unresolved=false&not.lang=fr&not.title=Mers-el-K%C3%A9bir&limit=50",
  )
  assert.ok(parsed.success)
  assert.deepEqual(parsed.data, {
    type: ["press", "book"],
    kind: ["periodical_issue"],
    title: ["Oran", "Alger"],
    creator: ["Hugo"],
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
})

test("encoding then decoding returns the same filter set", () => {
  const filters: BufferFilterSet = {
    type: ["press"],
    kind: ["monograph", "image"],
    yearFrom: 1880,
    yearTo: 1890,
    undated: true,
    q: "incendie",
    not: { lang: ["fr"], unresolved: true },
  }
  const parsed = parseQs(bufferFiltersToParams(filters).toString())
  assert.ok(parsed.success)
  assert.deepEqual(parsed.data, filters)
})
