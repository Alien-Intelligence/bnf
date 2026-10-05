// lib/async/periodic.test.ts
// A named sweep runs at most once: a re-start replaces it (dev hot-reload
// re-running instrumentation's register()), and stop() clears only its own.
import { test } from "node:test"
import assert from "node:assert/strict"

import { runningPeriodics, startPeriodic } from "./periodic"

test("startPeriodic: a second start of the same name replaces the first", async () => {
  let first = 0
  let second = 0
  startPeriodic("t-replace", 5, async () => {
    first += 1
  })
  const handle = startPeriodic("t-replace", 5, async () => {
    second += 1
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  handle.stop()
  assert.equal(first, 0, "the replaced timer never ran")
  assert.ok(second > 0, "the replacing timer runs")
  assert.deepEqual(runningPeriodics().filter((n) => n === "t-replace"), [])
})

test("startPeriodic: a failing run is logged and the sweep keeps running", async () => {
  let runs = 0
  const handle = startPeriodic("t-fail", 5, async () => {
    runs += 1
    throw new Error("transient")
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  handle.stop()
  assert.ok(runs >= 2, `ran ${runs} times`)
})

test("startPeriodic: a stale handle does not stop its replacement", () => {
  const stale = startPeriodic("t-stale", 1_000, async () => {})
  const fresh = startPeriodic("t-stale", 1_000, async () => {})
  stale.stop()
  assert.ok(runningPeriodics().includes("t-stale"))
  fresh.stop()
  assert.ok(!runningPeriodics().includes("t-stale"))
})
