// models/ingest/service.test.ts
// computeRetryArks (audit finding F20) — the pure selection logic behind
// IngestService.retryFailed, tested standalone with hand-built inputs. No
// Prisma calls: the codebase has no established pattern for mocking Prisma,
// so the fallback rule was extracted into a pure function specifically to
// make it testable without one (see the module doc on computeRetryArks).
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { computeRetryArks } from "./service"

const ARK1 = "ark:/12148/bpt6k000001"
const ARK2 = "ark:/12148/bpt6k000002"
const ARK3 = "ark:/12148/bpt6k000003"

test("stats.errors present → those ARKs, Document rows ignored entirely", () => {
  const result = computeRetryArks(
    [{ ark: ARK1 }, { ark: ARK2 }],
    [ARK1, ARK2, ARK3],
    // Even a contradictory doc-row set must not matter — stats wins outright.
    [{ ark: ARK3, indexedAt: null, indexError: "boom" }],
  )
  assert.deepEqual(result, [ARK1, ARK2])
})

test("stats.errors absent → falls back to Document rows never indexed with a recorded error", () => {
  const result = computeRetryArks(
    [],
    [ARK1, ARK2, ARK3],
    [
      { ark: ARK1, indexedAt: null, indexError: "metadata_unavailable_after_retries" },
      { ark: ARK2, indexedAt: new Date(), indexError: null }, // succeeded — excluded
    ],
  )
  assert.deepEqual(result, [ARK1])
})

test("fallback ignores Document rows outside addedArks (defensive — caller is expected to pre-filter)", () => {
  const result = computeRetryArks(
    [],
    [ARK1],
    [
      { ark: ARK1, indexedAt: null, indexError: "boom" },
      { ark: "ark:/12148/not-in-this-job", indexedAt: null, indexError: "boom" },
    ],
  )
  assert.deepEqual(result, [ARK1])
})

test("fallback excludes rows with indexedAt set even if indexError is (stale) non-null", () => {
  const result = computeRetryArks(
    [],
    [ARK1],
    [{ ark: ARK1, indexedAt: new Date(), indexError: "stale error text" }],
  )
  assert.deepEqual(result, [])
})

test("fallback excludes rows with no recorded error (indexedAt null, indexError null)", () => {
  const result = computeRetryArks(
    [],
    [ARK1],
    [{ ark: ARK1, indexedAt: null, indexError: null }],
  )
  assert.deepEqual(result, [])
})

test("both sources empty → []", () => {
  assert.deepEqual(computeRetryArks([], [ARK1, ARK2], []), [])
})
