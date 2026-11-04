// lib/cluster/composite-ids.test.ts
// The composite id format, built once from the separator and the segment
// counts: what each schema accepts and refuses, and the entry number.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COMPOSITE_ID_SEPARATOR,
  datasetIdSchema,
  entryIdSchema,
  entryOrdinal,
  DATASET_ID_SEGMENTS,
  ENTRY_ID_SEGMENTS,
} from "./composite-ids"

test("the format is a separator and two segment counts", () => {
  assert.equal(COMPOSITE_ID_SEPARATOR, ":")
  assert.equal(DATASET_ID_SEGMENTS, 2)
  assert.equal(ENTRY_ID_SEGMENTS, DATASET_ID_SEGMENTS + 1)
})

test("a dataset id is exactly cluster:dataset", () => {
  assert.equal(datasetIdSchema.safeParse("113:6363").success, true)
  for (const bad of ["113", "113:6363:1", ":6363", "113:", "a:b", "113:6363 ", 6363, ""]) {
    assert.equal(datasetIdSchema.safeParse(bad).success, false, JSON.stringify(bad))
  }
})

test("an entry id is exactly cluster:dataset:entry", () => {
  assert.equal(entryIdSchema.safeParse("113:6363:9195583").success, true)
  for (const bad of ["113:6363", "113:6363:9195583:1", "113:6363:", "113::1", "113:6363:x", 9195583, ""]) {
    assert.equal(entryIdSchema.safeParse(bad).success, false, JSON.stringify(bad))
  }
})

test("entryOrdinal is the entry number, compared numerically and beyond the safe-integer range", () => {
  assert.equal(entryOrdinal(entryIdSchema.parse("113:6363:9195583")), BigInt(9195583))
  assert.ok(entryOrdinal(entryIdSchema.parse("1:1:100")) > entryOrdinal(entryIdSchema.parse("1:1:9")))
  assert.equal(entryOrdinal(entryIdSchema.parse("1:1:9007199254740993")), BigInt("9007199254740993"))
})
