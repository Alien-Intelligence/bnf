// lib/ingest/watchdog.test.ts
// Pure rule-set tests for decideWatchdogAction (audit finding F18) — a fake
// clock and hand-built job/progress fixtures, no database, no worker HTTP.
// The interval shell (startIngestWatchdog) is I/O-only and exercised manually
// (see the plan's "run-local" validation gate), not here; one job's
// reconciliation across ticks is, with the worker poll and the write stubbed.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { ClusterRunner } from "@/lib/cluster/runner"
import { IngestService } from "@/models/ingest/service"
import {
  decideWatchdogAction,
  reconcileWatchdogJob,
  WATCHDOG_QUEUED_STALE_MS,
  WATCHDOG_MAX_REDELIVERS,
  WATCHDOG_REDELIVER_MIN_GAP_MS,
  WATCHDOG_RUNNING_STALE_MS,
  type WatchdogJobInput,
} from "./watchdog"
import {
  type ClusterProgressPoll,
  type ClusterQueueProgress,
} from "@/lib/cluster/contracts"
import { CLUSTER_POLL, CLUSTER_TERMINAL_DELIVERY, INGEST_STATUS } from "@/models/ingest/schema"

const UNKNOWN: ClusterProgressPoll = { kind: CLUSTER_POLL.RUN_UNKNOWN }
function polled(progress: ClusterQueueProgress): ClusterProgressPoll {
  return { kind: CLUSTER_POLL.PROGRESS, progress }
}

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
    status: INGEST_STATUS.RUNNING,
    clusterJobId: "run-1",
    createdAt: minutesAgo(45),
    ...overrides,
  }
}

function queuedJob(overrides: Partial<WatchdogJobInput> = {}): WatchdogJobInput {
  return {
    id: "job-2",
    status: INGEST_STATUS.QUEUED,
    clusterJobId: null,
    createdAt: minutesAgo(45),
    ...overrides,
  }
}

// --- none -------------------------------------------------------------------

test("QUEUED younger than the stale threshold → none", () => {
  const job = queuedJob({ createdAt: minutesAgo(5) })
  assert.ok(5 * 60_000 < WATCHDOG_QUEUED_STALE_MS)
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null, null, 0)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince, null)
})

test("RUNNING with no clusterJobId yet → none (still inside the submit window)", () => {
  const job = runningJob({ clusterJobId: null })
  const { action } = decideWatchdogAction(job, null, NOW, null, null, 0)
  assert.deepEqual(action, { kind: "none" })
})

test("QUEUED that already has a clusterJobId → none (not this rule's business)", () => {
  const job = queuedJob({ clusterJobId: "run-mid-transition", createdAt: minutesAgo(999) })
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null, null, 0)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince, null)
})

test("RUNNING with the run unknown (404) under the stale threshold → none, but tracks nullSince", () => {
  const { action, nullSince } = decideWatchdogAction(runningJob(), UNKNOWN, NOW, null, null, 0)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince?.getTime(), NOW.getTime(), "starts the staleness clock at `now`")
})

// --- write_progress -----------------------------------------------------------

test("RUNNING + non-null progress → write_progress with the docs-terminal fraction", () => {
  const p = progress({ docsTotal: 465, docsFinished: 331, docs: { done: 331, failed: 133, queued: 1 } })
  const { action, nullSince } = decideWatchdogAction(runningJob(), polled(p), NOW, minutesAgo(10), null, 0)
  assert.deepEqual(action, {
    kind: "write_progress",
    progress: 331 / 465,
    stats: { done: 331, failed: 133, queued: 1 },
  })
  assert.equal(nullSince, null, "progress arriving clears any tracked staleness")
})

test("write_progress fraction is 0 when docsTotal is 0 (never divides by zero)", () => {
  const p = progress({ docsTotal: 0, docsFinished: 0 })
  const { action } = decideWatchdogAction(runningJob(), polled(p), NOW, null, null, 0)
  assert.equal(action.kind, "write_progress")
  if (action.kind === "write_progress") assert.equal(action.progress, 0)
})

// --- fail-queued --------------------------------------------------------------

test("QUEUED older than 15 min with no clusterJobId → fail (F19 corpse)", () => {
  const job = queuedJob({ createdAt: new Date(NOW.getTime() - WATCHDOG_QUEUED_STALE_MS - 1) })
  const { action, nullSince } = decideWatchdogAction(job, null, NOW, null, null, 0)
  assert.deepEqual(action, {
    kind: "fail",
    reason: "soumission au worker jamais aboutie (watchdog)",
  })
  assert.equal(nullSince, null)
})

test("QUEUED exactly at the threshold does not fail (strictly greater-than)", () => {
  const job = queuedJob({ createdAt: new Date(NOW.getTime() - WATCHDOG_QUEUED_STALE_MS) })
  const { action } = decideWatchdogAction(job, null, NOW, null, null, 0)
  assert.deepEqual(action, { kind: "none" })
})

// --- fail-stale ---------------------------------------------------------------

test("RUNNING with the run unknown continuously for > 30 min → fail", () => {
  const staleSince = new Date(NOW.getTime() - WATCHDOG_RUNNING_STALE_MS - 1)
  const { action, nullSince } = decideWatchdogAction(runningJob(), UNKNOWN, NOW, staleSince, null, 0)
  assert.deepEqual(action, {
    kind: "fail",
    reason: "run inconnu du worker depuis 30 min (watchdog)",
  })
  assert.equal(nullSince, null, "nothing left to track once the job is about to go terminal")
})

test("RUNNING with the run unknown for exactly 30 min does not yet fail (strictly greater-than)", () => {
  const staleSince = new Date(NOW.getTime() - WATCHDOG_RUNNING_STALE_MS)
  const { action, nullSince } = decideWatchdogAction(runningJob(), UNKNOWN, NOW, staleSince, null, 0)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince?.getTime(), staleSince.getTime(), "clock is not reset while still under threshold")
})

test("a single null tick starts the clock; a later non-null tick resets it before staleness ever fires", () => {
  // Tick 1: worker unreachable, first time.
  const t1 = decideWatchdogAction(runningJob(), UNKNOWN, minutesAgo(40), null, null, 0)
  assert.deepEqual(t1.action, { kind: "none" })
  assert.ok(t1.nullSince)

  // Tick 2 (10 minutes later, still within the 30-min budget): progress comes back.
  const t2 = decideWatchdogAction(runningJob(), polled(progress()), minutesAgo(30), t1.nullSince, null, 0)
  assert.equal(t2.action.kind, "write_progress")
  assert.equal(t2.nullSince, null)

  // Tick 3: null again — the clock restarts from THIS tick, not tick 1's timestamp.
  const t3 = decideWatchdogAction(runningJob(), UNKNOWN, minutesAgo(20), t2.nullSince, null, 0)
  assert.deepEqual(t3.action, { kind: "none" })
  assert.equal(t3.nullSince?.getTime(), minutesAgo(20).getTime())
})

// --- an outage is not "the run is gone" ------------------------------------

for (const poll of [
  { kind: CLUSTER_POLL.WORKER_UNREACHABLE, detail: "ECONNREFUSED" },
  { kind: CLUSTER_POLL.WORKER_ERROR, status: 503 },
] as const) {
  test(`RUNNING with the worker ${poll.kind} → none, the clock is held (not started, not reset)`, () => {
    const fresh = decideWatchdogAction(runningJob(), poll, NOW, null, null, 0)
    assert.deepEqual(fresh, { action: { kind: "none" }, nullSince: null }, "never starts the clock")
    const staleSince = new Date(NOW.getTime() - WATCHDOG_RUNNING_STALE_MS - 1)
    const held = decideWatchdogAction(runningJob(), poll, NOW, staleSince, null, 0)
    assert.deepEqual(held.action, { kind: "none" }, "never fails the job during an outage")
    assert.equal(held.nullSince?.getTime(), staleSince.getTime(), "and never resets it either")
  })
}

test("a FAILED write that throws keeps the staleness clock: the next tick fails the job at once", async () => {
  const job = runningJob({ id: "job-write-fails" })
  const original = { progress: ClusterRunner.progress, failStuckJob: IngestService.failStuckJob }
  const failCalls: Date[] = []
  let writeFails = true
  ClusterRunner.progress = async () => ({ kind: CLUSTER_POLL.RUN_UNKNOWN }) // the run is gone
  IngestService.failStuckJob = async (_id, _status, _reason, at) => {
    failCalls.push(at)
    if (writeFails) throw new Error("database unavailable")
  }
  try {
    // Tick 1: the worker stops answering — the clock starts.
    await reconcileWatchdogJob(job, minutesAgo(40))
    assert.equal(failCalls.length, 0)
    // Tick 2: 31 min later the job is given up on, but the write fails.
    await assert.rejects(reconcileWatchdogJob(job, minutesAgo(9)), /database unavailable/)
    // Tick 3: one minute later the clock still says 32 min: failed again at once.
    writeFails = false
    await reconcileWatchdogJob(job, minutesAgo(8))
    assert.deepEqual(failCalls, [minutesAgo(9), minutesAgo(8)])
    // Tick 4: written — the clock is cleared, nothing left to track.
    await reconcileWatchdogJob(job, minutesAgo(7))
    assert.equal(failCalls.length, 2, "a fresh clock started; no immediate re-fail")
  } finally {
    ClusterRunner.progress = original.progress
    IngestService.failStuckJob = original.failStuckJob
  }
})

test("a job in a terminal status is never judged by the RUNNING rules", () => {
  const job = runningJob({ status: INGEST_STATUS.DONE, createdAt: minutesAgo(600) })
  const { action, nullSince } = decideWatchdogAction(job, UNKNOWN, NOW, minutesAgo(600), null, 0)
  assert.deepEqual(action, { kind: "none" })
  assert.equal(nullSince, null)
})

// --- abandoned terminal callback → redeliver --------------------------------

const abandoned = () => polled(progress({ terminalDelivery: CLUSTER_TERMINAL_DELIVERY.ABANDONED }))

test("RUNNING + worker reports abandoned, never asked → redeliver (no progress write, clock cleared)", () => {
  const { action, nullSince } = decideWatchdogAction(runningJob(), abandoned(), NOW, minutesAgo(10), null, 0)
  assert.deepEqual(action, { kind: "redeliver" })
  assert.equal(nullSince, null)
})

test("abandoned: at most one redeliver per window — strictly after the gap it is asked again", () => {
  const within = decideWatchdogAction(runningJob(), abandoned(), NOW, null, minutesAgo(5), 0)
  assert.deepEqual(within.action, { kind: "none" })
  const atGap = new Date(NOW.getTime() - WATCHDOG_REDELIVER_MIN_GAP_MS)
  assert.deepEqual(decideWatchdogAction(runningJob(), abandoned(), NOW, null, atGap, 0).action, { kind: "none" })
  const past = new Date(NOW.getTime() - WATCHDOG_REDELIVER_MIN_GAP_MS - 1)
  assert.deepEqual(decideWatchdogAction(runningJob(), abandoned(), NOW, null, past, 0).action, { kind: "redeliver" })
})

for (const delivery of [CLUSTER_TERMINAL_DELIVERY.PENDING, CLUSTER_TERMINAL_DELIVERY.EMITTED, undefined]) {
  test(`terminalDelivery ${delivery ?? "absent (older worker)"} → unchanged: write_progress, never redeliver`, () => {
    const p = progress({ terminalDelivery: delivery })
    for (const last of [null, minutesAgo(600)]) {
      const { action } = decideWatchdogAction(runningJob(), polled(p), NOW, null, last, 0)
      assert.equal(action.kind, "write_progress")
    }
  })
}

test("a QUEUED or terminal job is never redelivered, whatever the worker says", () => {
  for (const status of [INGEST_STATUS.QUEUED, INGEST_STATUS.DONE, INGEST_STATUS.PARTIAL, INGEST_STATUS.CANCELED]) {
    const { action } = decideWatchdogAction(runningJob({ status }), abandoned(), NOW, null, null, 0)
    assert.notEqual(action.kind, "redeliver", status)
  }
})

test("the shell asks the worker once per window across ticks, and again after it", async () => {
  const job = runningJob({ id: "job-abandoned" })
  const original = { progress: ClusterRunner.progress, redeliver: IngestService.redeliverAbandoned, warn: console.warn }
  const asked: string[] = []
  const warnings: unknown[][] = []
  ClusterRunner.progress = async () => abandoned()
  IngestService.redeliverAbandoned = async (id) => {
    asked.push(id)
    return true
  }
  console.warn = (...args: unknown[]) => void warnings.push(args)
  try {
    await reconcileWatchdogJob(job, minutesAgo(100))
    await reconcileWatchdogJob(job, minutesAgo(99)) // next tick: inside the window
    await reconcileWatchdogJob(job, minutesAgo(70)) // still inside (30 min exactly is not past the gap)
    assert.deepEqual(asked, ["run-1"])
    await reconcileWatchdogJob(job, minutesAgo(69)) // past the window
    assert.deepEqual(asked, ["run-1", "run-1"])
    assert.equal(warnings.length, 2, "one structured warn per request")
    assert.deepEqual(warnings[0]![1], { jobId: "job-abandoned", clusterJobId: "run-1", accepted: true })
  } finally {
    ClusterRunner.progress = original.progress
    IngestService.redeliverAbandoned = original.redeliver
    console.warn = original.warn
  }
})

test("a redeliver request that throws is raised, and waits out the window instead of retrying every tick", async () => {
  const job = runningJob({ id: "job-redeliver-throws" })
  const original = { progress: ClusterRunner.progress, redeliver: IngestService.redeliverAbandoned }
  let calls = 0
  ClusterRunner.progress = async () => abandoned()
  IngestService.redeliverAbandoned = async () => {
    calls += 1
    throw new Error("worker returned 500")
  }
  try {
    await assert.rejects(reconcileWatchdogJob(job, minutesAgo(50)), /worker returned 500/)
    await reconcileWatchdogJob(job, minutesAgo(49))
    assert.equal(calls, 1)
  } finally {
    ClusterRunner.progress = original.progress
    IngestService.redeliverAbandoned = original.redeliver
  }
})

// --- the redeliver cycle has a ceiling --------------------------------------

test("abandoned with count < max → redeliver; count = max → fail with the French delivery reason", () => {
  for (let n = 0; n < WATCHDOG_MAX_REDELIVERS; n++) {
    const { action } = decideWatchdogAction(runningJob(), abandoned(), NOW, null, null, n)
    assert.deepEqual(action, { kind: "redeliver" }, `count ${n}`)
  }
  const { action, nullSince } = decideWatchdogAction(runningJob(), abandoned(), NOW, null, null, WATCHDOG_MAX_REDELIVERS)
  assert.equal(action.kind, "fail")
  if (action.kind === "fail") {
    assert.match(action.reason, /résultat n'a pas pu être livré après 3 tentatives/)
    assert.match(action.reason, /relancer l'ingestion/)
  }
  assert.equal(nullSince, null)
})

test("the min-gap still applies below the max", () => {
  const { action } = decideWatchdogAction(runningJob(), abandoned(), NOW, null, minutesAgo(5), 1)
  assert.deepEqual(action, { kind: "none" })
})

test("the shell: progress writes between abandonments do not reset the count — the job is failed after the max", async () => {
  const job = runningJob({ id: "job-redeliver-cycle" })
  const original = {
    progress: ClusterRunner.progress,
    redeliver: IngestService.redeliverAbandoned,
    failStuckJob: IngestService.failStuckJob,
    mirror: IngestService.mirrorWatchdogProgress,
    warn: console.warn,
  }
  let abandonedNow = true
  let asked = 0
  const failed: string[] = []
  ClusterRunner.progress = async () => (abandonedNow ? abandoned() : polled(progress()))
  IngestService.redeliverAbandoned = async () => {
    asked += 1
    return true
  }
  IngestService.failStuckJob = async (_id, _status, reason) => void failed.push(reason)
  IngestService.mirrorWatchdogProgress = async () => {}
  console.warn = () => {}
  try {
    let t = 1000
    for (let cycle = 0; cycle < WATCHDOG_MAX_REDELIVERS; cycle++) {
      abandonedNow = true
      await reconcileWatchdogJob(job, minutesAgo(t))
      t -= 1
      abandonedNow = false // redelivered, the run is pending again: a progress write
      await reconcileWatchdogJob(job, minutesAgo(t))
      t -= 200 // the next abandonment, hours later
    }
    assert.equal(asked, WATCHDOG_MAX_REDELIVERS)
    assert.equal(failed.length, 0)
    abandonedNow = true
    await reconcileWatchdogJob(job, minutesAgo(t))
    assert.equal(asked, WATCHDOG_MAX_REDELIVERS, "no further request")
    assert.equal(failed.length, 1)
    assert.match(failed[0]!, /relancer l'ingestion/)
  } finally {
    ClusterRunner.progress = original.progress
    IngestService.redeliverAbandoned = original.redeliver
    IngestService.failStuckJob = original.failStuckJob
    IngestService.mirrorWatchdogProgress = original.mirror
    console.warn = original.warn
  }
})

test("IngestService.redeliverAbandoned returns the cluster runner's answer and raises its errors", async () => {
  const original = ClusterRunner.redeliver
  try {
    ClusterRunner.redeliver = async (id) => id === "run-accepted"
    assert.equal(await IngestService.redeliverAbandoned("run-accepted"), true)
    assert.equal(await IngestService.redeliverAbandoned("run-refused"), false)
    ClusterRunner.redeliver = async () => {
      throw new Error("worker returned 500")
    }
    await assert.rejects(IngestService.redeliverAbandoned("run-1"), /worker returned 500/)
  } finally {
    ClusterRunner.redeliver = original
  }
})
