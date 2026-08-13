// models/ingest/service.test.ts
// computeRetryArks (audit finding F20) — the pure selection logic behind
// IngestService.retryFailed, tested standalone with hand-built inputs. No
// Prisma calls: the codebase has no established pattern for mocking Prisma,
// so the fallback rule was extracted into a pure function specifically to
// make it testable without one (see the module doc on computeRetryArks).
//
// countNonWarningErrors / parseErrorEntries / splitSucceededArks (F13,
// ai-memories/tech/repos/bnf/ingest-hardening) — same precedent, for the
// warning-channel logic behind applyProgress's commit()/commitPartialFailure()
// routing decision and the succeeded/failed ARK split.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeRetryArks,
  countNonWarningErrors,
  parseErrorEntries,
  splitSucceededArks,
} from "./service"

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

// ── F13 warning channel ──────────────────────────────────────────────────────

test("countNonWarningErrors: an all-warning errors[] counts as zero failures", () => {
  const n = countNonWarningErrors([{ warning: true }, { warning: true }])
  assert.equal(n, 0)
})

test("countNonWarningErrors: a real failure counts, a warning next to it does not", () => {
  const n = countNonWarningErrors([{ warning: undefined }, { warning: true }])
  assert.equal(n, 1)
})

test("countNonWarningErrors: empty errors[] → 0", () => {
  assert.equal(countNonWarningErrors([]), 0)
})

test("parseErrorEntries: a warning entry is parsed with warning=true and its reason preserved", () => {
  const entries = parseErrorEntries([
    { ark: ARK1, stage: "mistral", reason: "pages partiellement illisibles: 5/6…", warning: true },
  ])
  assert.deepEqual(entries.get(ARK1), {
    reason: "pages partiellement illisibles: 5/6…",
    warning: true,
  })
})

test("parseErrorEntries: a real failure entry parses with warning=false", () => {
  const entries = parseErrorEntries([{ ark: ARK1, stage: "text", reason: "page-fail-ratio 3/4" }])
  assert.deepEqual(entries.get(ARK1), { reason: "page-fail-ratio 3/4", warning: false })
})

test("parseErrorEntries: falls back to `stage` then \"échec\" when `reason` is missing/non-string", () => {
  const entries = parseErrorEntries([
    { ark: ARK1, stage: "vision" },
    { ark: ARK2 },
  ])
  assert.equal(entries.get(ARK1)?.reason, "vision")
  assert.equal(entries.get(ARK2)?.reason, "échec")
})

test("parseErrorEntries: entries with no `ark` string are skipped defensively", () => {
  const entries = parseErrorEntries([{ reason: "orphan" }, { ark: 42 }])
  assert.equal(entries.size, 0)
})

test("splitSucceededArks: a warning-only ARK stays in `succeeded`, never in `failed`", () => {
  const entries = parseErrorEntries([{ ark: ARK1, reason: "…", warning: true }])
  const { succeeded, failed } = splitSucceededArks([ARK1, ARK2], entries)
  assert.deepEqual(succeeded, [ARK1, ARK2])
  assert.deepEqual(failed, [])
})

test("splitSucceededArks: a real failure ARK is excluded from `succeeded` and listed in `failed`", () => {
  const entries = parseErrorEntries([{ ark: ARK1, reason: "boom" }])
  const { succeeded, failed } = splitSucceededArks([ARK1, ARK2], entries)
  assert.deepEqual(succeeded, [ARK2])
  assert.deepEqual(failed, [ARK1])
})

test("splitSucceededArks: mixed warning + real failure ARKs split correctly", () => {
  const entries = parseErrorEntries([
    { ark: ARK1, reason: "boom" }, // real failure
    { ark: ARK2, reason: "…", warning: true }, // warning — still succeeds
  ])
  const { succeeded, failed } = splitSucceededArks([ARK1, ARK2, ARK3], entries)
  assert.deepEqual(succeeded, [ARK2, ARK3])
  assert.deepEqual(failed, [ARK1])
})
