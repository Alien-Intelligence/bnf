// lib/agent/tools/provisional-total.test.ts
// buffer_commit and corpus_add say when the total they report will still move
// (feedback #10c: the agent announced 58, the head held 44 thirty seconds later).
import { test } from "node:test"
import assert from "node:assert/strict"
import { provisionalTotal } from "./provisional-total"

test("a settled total carries no next_step", () => {
  assert.deepEqual(provisionalTotal(0, 0), { canonicalizationPending: 0, totalIsProvisional: false })
})

test("pending canonicalisation makes the total provisional and says to re-read", () => {
  const r = provisionalTotal(16, 0)
  assert.equal(r.totalIsProvisional, true)
  assert.match(r.next_step ?? "", /16 notice\(s\) catalogue/)
  assert.match(r.next_step ?? "", /Relis `corpus_get_state` avant d'annoncer un nombre de documents/)
})

test("pending resolution alone is also provisional, with its own clause", () => {
  const r = provisionalTotal(0, 3)
  assert.equal(r.totalIsProvisional, true)
  assert.doesNotMatch(r.next_step ?? "", /notice/)
  assert.match(r.next_step ?? "", /3 document\(s\) sont encore en cours de résolution/)
})
