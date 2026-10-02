// tests/api/buffer-filters.test.ts
// The buffer's REST/UI query-string boundary (models/buffer/types.ts). Found
// bug: `z.coerce.boolean()` turns the string "false" into `true`, so
// `GET /api/projects/:id/buffer?undated=false` returned the UNDATED candidates.
// The route also redefined its own copy of the schema; it now parses the
// shared one and converts it with bufferFiltersToSet.
import { test } from "node:test"
import assert from "node:assert/strict"
import { bufferFiltersSchema, bufferFiltersToSet } from "@/models/buffer/types"

test("undated=false parses as false, undated=true and 1 as true", () => {
  assert.equal(bufferFiltersSchema.parse({ undated: "false" }).undated, false)
  assert.equal(bufferFiltersSchema.parse({ undated: "0" }).undated, false)
  assert.equal(bufferFiltersSchema.parse({ undated: "true" }).undated, true)
  assert.equal(bufferFiltersSchema.parse({ undated: "1" }).undated, true)
  assert.equal(bufferFiltersSchema.parse({}).undated, undefined)
  assert.equal(bufferFiltersSchema.safeParse({ undated: "yes" }).success, false)
})

test("CSV kind / title / creator / subject become arrays", () => {
  const parsed = bufferFiltersSchema.parse({
    type: "press, book",
    kind: "periodical_issue",
    title: "Oran, Alger ,",
    creator: "Hugo",
    subject: "Incendies",
    yearFrom: "1937",
  })
  assert.deepEqual(bufferFiltersToSet(parsed), {
    type: ["press", "book"],
    kind: ["periodical_issue"],
    title: ["Oran", "Alger"],
    creator: ["Hugo"],
    subject: ["Incendies"],
    yearFrom: 1937,
  })
})

test("an unknown kind is refused at the boundary", () => {
  assert.equal(bufferFiltersSchema.safeParse({ kind: "pamphlet" }).success, false)
})
