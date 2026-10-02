// lib/cluster/client.test.ts
// parseWorkerTimeoutMs — found bug B6 (feedback 2026-09-29, Track B): a set but
// invalid WORKER_RUNNER_TIMEOUT_MS used to fall back to the 30 s default in
// silence, so a typo ("30s", "-1") ran with a timeout nobody configured. Unset
// still means the documented default; set-but-invalid now throws.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseWorkerTimeoutMs } from "./client"

test("unset → the documented 30 s default", () => {
  assert.equal(parseWorkerTimeoutMs(undefined), 30_000)
})

test("blank → the documented 30 s default", () => {
  assert.equal(parseWorkerTimeoutMs("  "), 30_000)
})

test("a positive integer is used as is", () => {
  assert.equal(parseWorkerTimeoutMs("45000"), 45_000)
})

test("set but invalid throws instead of silently defaulting", () => {
  for (const raw of ["30s", "abc", "0", "-1", "1.5", "Infinity"]) {
    assert.throws(() => parseWorkerTimeoutMs(raw), /WORKER_RUNNER_TIMEOUT_MS/, raw)
  }
})
