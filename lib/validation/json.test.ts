// lib/validation/json.test.ts
// toInputJson: the proof a loose wire record is JSON before it is written to a
// Json column (replacing the `as never` casts on the ingest stats writes).
import { test } from "node:test"
import assert from "node:assert/strict"

import { toInputJson } from "./json"

test("toInputJson: a nested JSON record passes through unchanged", () => {
  const stats = { docs: 3, by: { alto: 2, vision: null }, arks: ["a", "b"], ok: true }
  assert.deepEqual(toInputJson(stats), stats)
})

test("toInputJson: a value that is not JSON is refused, naming where", () => {
  assert.throws(() => toInputJson({ when: undefined }), /when/)
  assert.throws(() => toInputJson({ big: BigInt(1) }), /big/)
  assert.throws(() => toInputJson(() => 1))
})
