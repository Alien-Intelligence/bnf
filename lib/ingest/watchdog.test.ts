// lib/ingest/watchdog.test.ts
// Pure rule-set tests for decideWatchdogAction (audit finding F18) — a fake
// clock and hand-built job/progress fixtures, no database, no worker HTTP.
// The interval shell (startIngestWatchdog) is I/O-only and exercised manually
// (see the plan's "run-local" validation gate), not here.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  decideWatchdogAction,
  WATCHDOG_QUEUED_STALE_MS,
  WATCHDOG_RUNNING_STALE_MS,
  type WatchdogJobInput,
} from "./watchdog"
import type { ClusterQueueProgress } from "@/lib/cluster/contracts"

const NOW = new Date("2026-08-11T12:00:00.000Z")

function minutesAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60_000)
}

function progress(overrides: Partial<ClusterQueueProgress> = {}): ClusterQueueProgress {
  return {
    docs: { done: 3, failed: 0, queued: 2 },
    docsTotal: 5,
    docsFinished: 3,
    stages: {},
    folios: { expected: 10, done: 6, failed: 0 },
    fetchRatePerMin: 300,
    manifestRatePerMin: 40,
    etaSeconds: 60,
    reconciles: true,
    ...overrides,
  }
}

function runningJob(overrides: Partial<WatchdogJobInput> = {}): WatchdogJobInput {
  return {
    id: "job-1",
    status: "running",
    clusterJobId: "run-1",
    createdAt: minutesAgo(45),
    ...overrides,
  }
}

function queuedJob(overrides: Partial<WatchdogJobInput> = {}): WatchdogJobInput {
  return {
    id: "job-2",
    status: "queued",
    clusterJobId: null,
    createdAt: minutesAgo(45),
    ...overrides,
  }
}

// --- none -------------------------------------------------------------------

test("QUEUED younger than the stale threshold → none", () => {
  const job = queuedJob({ createdAt: minutesAgo(5) })
  assert.ok(5 * 60_000 < WATCHDOG_QUEUED_STALE_MS)
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince, null)
})

test("RUNNING with no clusterJobId yet → none (still inside the submit window)", () => {
  const job = runningJob({ clusterJobId: null })
  const { action } = decideWatchdogAction(job, null, NOW, null)
  assert.deepEqual(action, { kind: "none" })
})

test("QUEUED that already has a clusterJobId → none (not this rule's business)", () => {
  const job = queuedJob({ clusterJobId: "run-mid-transition", createdAt: minutesAgo(999) })
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince, null)
})

test("RUNNING with null progress under the stale threshold → none, but tracks nullSince", () => {
  const { action, nullSince } = decideWatchdogAction(runningJob(), null, NOW, null)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince?.getTime(), NOW.getTime(), "starts the staleness clock at `now`")
})

// --- write_progress -----------------------------------------------------------

test("RUNNING + non-null progress → write_progress with the docs-terminal fraction", () => {
  const p = progress({ docsTotal: 465, docsFinished: 331, docs: { done: 331, failed: 133, queued: 1 } })
  const { action, nullSince } = decideWatchdogAction(runningJob(), p, NOW, minutesAgo(10))
  assert.deepEqual(action, {
    kind: "write_progress",
    progress: 331 / 465,
    stats: { done: 331, failed: 133, queued: 1 },
  })
  assert.equal(nullSince, null, "progress arriving clears any tracked staleness")
})

test("write_progress fraction is 0 when docsTotal is 0 (never divides by zero)", () => {
  const p = progress({ docsTotal: 0, docsFinished: 0 })
  const { action } = decideWatchdogAction(runningJob(), p, NOW, null)
  assert.equal(action.kind, "write_progress")
  if (action.kind === "write_progress") assert.equal(action.progress, 0)
})

// --- fail-queued --------------------------------------------------------------

test("QUEUED older than 15 min with no clusterJobId → fail (F19 corpse)", () => {
  const job = queuedJob({ createdAt: new Date(NOW.getTime() - WATCHDOG_QUEUED_STALE_MS - 1) })
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null)
  assert.deepEqual(action, {
    kind: "fail",
    reason: "soumission au worker jamais aboutie (watchdog)",
  })
  assert.equal(nullSince, null)
})

test("QUEUED exactly at the threshold does not fail (strictly greater-than)", () => {
  const job = queuedJob({ createdAt: new Date(NOW.getTime() - WATCHDOG_QUEUED_STALE_MS) })
  const { action } = decideWatchdogAction(job, null, NOW, null)
  assert.deepEqual(action, { kind: "none" })
})

// --- fail-stale ---------------------------------------------------------------

test("RUNNING with progress null continuously for > 30 min → fail (worker unreachable)", () => {
  const staleSince = new Date(NOW.getTime() - WATCHDOG_RUNNING_STALE_MS - 1)
  const { action, nullSince } = decideWatchdogAction(runningJob(), null, NOW, staleSince)
  assert.deepEqual(action, {
    kind: "fail",
    reason: "worker injoignable / run inconnu depuis 30 min (watchdog)",
  })
  assert.equal(nullSince, null, "nothing left to track once the job is about to go terminal")
})

test("RUNNING with progress null for exactly 30 min does not yet fail (strictly greater-than)", () => {
  const staleSince = new Date(NOW.getTime() - WATCHDOG_RUNNING_STALE_MS)
  const { action, nullSince } = decideWatchdogAction(runningJob(), null, NOW, staleSince)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince?.getTime(), staleSince.getTime(), "clock is not reset while still under threshold")
})

test("a single null tick starts the clock; a later non-null tick resets it before staleness ever fires", () => {
  // Tick 1: worker unreachable, first time.
  const t1 = decideWatchdogAction(runningJob(), null, minutesAgo(40), null)
  assert.deepEqual(t1.action, { kind: "none" })
  assert.ok(t1.nullSince)

  // Tick 2 (10 minutes later, still within the 30-min budget): progress comes back.
  const t2 = decideWatchdogAction(runningJob(), progress(), minutesAgo(30), t1.nullSince)
  assert.equal(t2.action.kind, "write_progress")
  assert.equal(t2.nullSince, null)

  // Tick 3: null again — the clock restarts from THIS tick, not tick 1's timestamp.
  const t3 = decideWatchdogAction(runningJob(), null, minutesAgo(20), t2.nullSince)
  assert.deepEqual(t3.action, { kind: "none" })
  assert.equal(t3.nullSince?.getTime(), minutesAgo(20).getTime())
})
