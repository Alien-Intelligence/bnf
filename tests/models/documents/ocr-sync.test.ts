// tests/models/documents/ocr-sync.test.ts
// The OCR-quality sync drainer (feedback 2026-09-29 #7, Track B): its pure
// helpers, the coverage check that turns an incomplete worker answer into a
// typed contract error, and — through fake ports — the drainer's decisions:
// which failure pauses what, when an ARK is asked alone, when a failure is
// struck with a control, the rotation and its cursors, the deadline and
// re-entrancy. The persisted semantics behind the ports (what a strike, an
// outage or a rejection writes) are tested against Postgres in
// ocr-record.test.ts, and the whole drainer runs on the real ports and the
// production constants in ocr-sync-pg.test.ts.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_SYNC_BACKOFF_BASE_MS, OCR_SYNC_BACKOFF_MAX_MS } from "@/lib/constants"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
  type WorkerSyncAnswer,
} from "@/lib/cluster/ocr-quality"
import {
  OCR_SYNC_ALONE_FROM,
  OCR_SYNC_STOP,
  createOcrSyncDrainer,
  remainingMs,
  type OcrSyncLimits,
  type OcrSyncPorts,
} from "@/lib/documents/ocr-sync"
import type { OcrSyncBatchResult } from "@/models/documents/schema"
import { OCR_ALONE_OUTCOME, assertSyncCoverage, syncBackoffMs } from "@/models/documents/service"

const ark = (i: number) => `ark:/12148/bpt6k${String(i).padStart(6, "0")}`

function answer(over: Partial<WorkerSyncAnswer>): WorkerSyncAnswer {
  return { documents: [], building: [], unavailable: [], incompatible: [], broken: [], ...over }
}

test("remainingMs: never negative", () => {
  assert.equal(remainingMs(1_000, 400), 600)
  assert.equal(remainingMs(1_000, 5_000), 0)
})

test("syncBackoffMs: doubles from the base, capped", () => {
  assert.equal(syncBackoffMs(1), OCR_SYNC_BACKOFF_BASE_MS)
  assert.equal(syncBackoffMs(2), 2 * OCR_SYNC_BACKOFF_BASE_MS)
  assert.equal(syncBackoffMs(30), OCR_SYNC_BACKOFF_MAX_MS)
  assert.throws(() => syncBackoffMs(0))
})

test("assertSyncCoverage: exactly the asked ARKs → ok; incompatible and broken artifacts ARE answers", () => {
  assert.doesNotThrow(() =>
    assertSyncCoverage(
      [ark(1), ark(2), ark(3), ark(4), ark(5)],
      answer({
        documents: [
          { v: 1, ark: ark(1), ocrRate: null, lane: "vision", folios: [], builtAt: "2026-10-01T13:49:42.385Z" },
        ],
        building: [ark(2)],
        unavailable: [{ ark: ark(3), reason: "no_pages_artifact" }],
        incompatible: [{ ark: ark(4), v: 2 }],
        broken: [{ ark: ark(5), message: "duplicate folio 1" }],
      }),
    ),
  )
})

test("assertSyncCoverage: a missing ARK is a contract error pinned on that ARK", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], answer({ building: [ark(1)] })),
    (err: unknown) =>
      err instanceof OcrSyncContractError &&
      err.scope === OCR_SYNC_FAULT_SCOPE.ARKS &&
      err.culprits.join() === ark(2),
  )
})

test("assertSyncCoverage: an ARK nobody asked for is the exchange's fault", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1)], answer({ building: [ark(1), ark(9)] })),
    (err: unknown) => err instanceof OcrSyncContractError && err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE,
  )
})

test("assertSyncCoverage: an answer answering NOTHING of what was asked is the exchange's fault", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], answer({})),
    (err: unknown) =>
      err instanceof OcrSyncContractError && err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE && err.culprits.length === 0,
  )
})

// ---------------------------------------------------------------------------
// The drainer core through fake ports
// ---------------------------------------------------------------------------

const BATCH = 4

function built(arks: string[], over: Partial<OcrSyncBatchResult["plan"]> = {}): OcrSyncBatchResult {
  return {
    plan: { checkedAt: new Date(0), available: [], building: arks, unavailable: [], incompatible: [], ...over },
    broken: [],
  }
}

type AloneCall = { ark: string; controlled: boolean }

type Fake = {
  ports: OcrSyncPorts
  /** Every request the drainer made, in order. */
  asked: string[][]
  rejected: string[]
  batchOutages: string[][]
  alone: AloneCall[]
  errors: string[]
  clock: { now: number }
  /** ARKs still due, per corpus. */
  due: Map<string, string[]>
  /** The persisted outage count the fake models (recordBatchOutage). */
  outageCount: Map<string, number>
}

/**
 * Fake ports with the persisted outage count modelled the way the service
 * writes it: a batch outage adds one to every ARK of the batch; an answer or
 * a rejection settles the ARK (it leaves the due list); a failure alone backs
 * the ARK off (it leaves the due list for this test's horizon).
 */
function fakePorts(opts: {
  due: Record<string, string[]>
  resync?: Record<string, number>
  sync?: (arks: string[], signal: AbortSignal) => Promise<OcrSyncBatchResult>
  control?: string | null
  outageCount?: Record<string, number>
  batchCostMs?: number
}): Fake {
  const asked: string[][] = []
  const rejected: string[] = []
  const batchOutages: string[][] = []
  const alone: AloneCall[] = []
  const errors: string[] = []
  const clock = { now: 1_000_000 }
  const due = new Map(Object.entries(opts.due))
  const outageCount = new Map(Object.entries(opts.outageCount ?? {}))
  const settle = (arks: string[]) => {
    for (const [corpus, list] of due) due.set(corpus, list.filter((a) => !arks.includes(a)))
    for (const a of arks) outageCount.delete(a)
  }
  const ports: OcrSyncPorts = {
    pendingByCorpus: async () =>
      [...due].map(([corpusProjectId, list]) => ({
        corpusProjectId,
        pending: list.length,
        resync: list.length > 0 ? (opts.resync?.[corpusProjectId] ?? 0) : 0,
      })),
    pendingArks: async (corpusProjectId, limit) => {
      const list = due.get(corpusProjectId)
      if (list === undefined) throw new Error(`unknown corpus ${corpusProjectId}`)
      return list.slice(0, limit).map((a) => ({ ark: a, outageCount: outageCount.get(a) ?? 0 }))
    },
    controlArk: async (exclude) => {
      const control = opts.control ?? null
      return control !== null && !exclude.includes(control) ? control : null
    },
    syncBatch: async (arks, signal) => {
      asked.push(arks)
      const result = opts.sync ? await opts.sync(arks, signal) : built(arks)
      settle(arks.filter((a) => !result.broken.some((b) => b.ark === a)))
      return result
    },
    recordRejection: async (a) => {
      rejected.push(a)
      settle([a])
    },
    recordBatchOutage: async (arks) => {
      batchOutages.push(arks)
      for (const a of arks) outageCount.set(a, (outageCount.get(a) ?? 0) + 1)
    },
    recordAloneFailure: async (a, _message, { controlled }) => {
      alone.push({ ark: a, controlled })
      settle([a])
      return { outcome: controlled ? OCR_ALONE_OUTCOME.STRUCK : OCR_ALONE_OUTCOME.BACKOFF, strikes: controlled ? 1 : 0 }
    },
    batchCostMs: () => opts.batchCostMs ?? 0,
    now: () => clock.now,
    log: () => {},
    error: (message) => {
      errors.push(message)
    },
  }
  return { ports, asked, rejected, batchOutages, alone, errors, clock, due, outageCount }
}

const LIMITS: OcrSyncLimits = {
  drainDeadlineMs: 60_000,
  batchSize: BATCH,
  maxBatches: 10,
  isolationBudget: 10,
  maxAttempts: 5,
}
const ALIVE = new AbortController().signal
const DOWN = () => Promise.reject(new OcrSyncUnavailableError("ECONNREFUSED"))

test("drain: syncs every due ARK of every corpus, round-robin, one batch per corpus per round", async () => {
  const fake = fakePorts({ due: { p1: [ark(1), ark(2), ark(3), ark(4), ark(5)], p2: [ark(6)] } })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
  assert.deepEqual(fake.asked, [[ark(1), ark(2), ark(3), ark(4)], [ark(6)], [ark(5)]])
  assert.equal(report.tally.building, 6)
})

// --- B: the contract, per document ------------------------------------------

test("B: a broken artifact is rejected on its own ARK and the sync goes on — never paused", async () => {
  const bad = ark(2)
  const fake = fakePorts({
    due: { p1: [ark(1), bad, ark(3)], p2: [ark(9)] },
    sync: async (arks) => ({
      ...built(arks.filter((a) => a !== bad)),
      broken: arks.includes(bad) ? [{ ark: bad, message: "duplicate folio 1" }] : [],
    }),
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const report = await drainer.drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
  assert.equal(drainer.pausedUntil(), 0, "the sync is never paused for one document")
  assert.deepEqual(fake.rejected, [bad])
  assert.deepEqual(fake.asked, [[ark(1), bad, ark(3)], [ark(9)]], "the other corpus is served in the same drain")
})

test("B: a lone broken artifact — the only ARK asked — is rejected, never paused", async () => {
  const bad = ark(1)
  const fake = fakePorts({
    due: { p1: [bad] },
    sync: async () => ({ ...built([]), broken: [{ ark: bad, message: "duplicate folio 1" }] }),
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const report = await drainer.drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
  assert.equal(drainer.pausedUntil(), 0)
  assert.deepEqual(fake.rejected, [bad])
})

test("B: incompatible artifacts blame nobody and are logged at error level ONCE per drain, with both versions", async () => {
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2), ark(3), ark(4), ark(5)], p2: [ark(6)] },
    sync: async (arks) => built([], { incompatible: arks.map((a) => ({ ark: a, v: 2 })) }),
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
  assert.equal(report.tally.incompatible, 6)
  assert.deepEqual(fake.rejected, [])
  const skew = fake.errors.filter((m) => m.startsWith("artifact version mismatch"))
  assert.equal(skew.length, 1, "one line for three requests")
  assert.match(skew[0] ?? "", /6 ARK\(s\) answered with worker artifact v2, this app reads v1/)
})

test("B: named culprits (a 400 naming arks[i]) are rejected and the rest of the batch asked again", async () => {
  const poison = ark(2)
  const fake = fakePorts({
    due: { p1: [ark(1), poison, ark(3)] },
    sync: async (arks) => {
      if (arks.includes(poison)) {
        throw new OcrSyncContractError("arks[1] refused", { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits: [poison] })
      }
      return built(arks)
    },
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.rejected, [poison])
  assert.deepEqual(fake.asked, [[ark(1), poison, ark(3)], [ark(1), ark(3)]])
  assert.equal(report.tally.rejected, 1)
})

test("B: an exchange-level break pauses the sync without penalising any ARK, then recovers", async () => {
  let broken = true
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2)] },
    sync: async (arks) => {
      if (broken) throw new OcrSyncContractError("401", { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] })
      return built(arks)
    },
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const first = await drainer.drain(ALIVE)
  assert.equal(first.stop, OCR_SYNC_STOP.EXCHANGE_PAUSED)
  assert.deepEqual(fake.rejected, [])
  assert.equal(drainer.pausedUntil(), fake.clock.now + OCR_SYNC_BACKOFF_BASE_MS)

  const stillPaused = await drainer.drain(ALIVE)
  assert.equal(stillPaused.stop, OCR_SYNC_STOP.EXCHANGE_PAUSED, "no request while paused")
  assert.equal(fake.asked.length, 1)

  broken = false
  fake.clock.now += OCR_SYNC_BACKOFF_BASE_MS
  const recovered = await drainer.drain(ALIVE)
  assert.equal(recovered.stop, OCR_SYNC_STOP.DONE)
  assert.equal(drainer.pausedUntil(), 0)
})

// --- A: transport failures ----------------------------------------------------

test("A: a batch outage ends that corpus's turn only, counts against nobody, and paces that corpus", async () => {
  let down = true
  const fake = fakePorts({
    due: { a: [ark(1), ark(2)], b: [ark(3)] },
    sync: async (arks) => {
      if (down && arks.includes(ark(1))) throw new OcrSyncUnavailableError("502")
      return built(arks)
    },
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const report = await drainer.drain(ALIVE)
  assert.deepEqual(fake.batchOutages, [[ark(1), ark(2)]])
  assert.deepEqual(fake.asked.slice(1), [[ark(3)]], "corpus b is served despite a's outage")
  assert.deepEqual([fake.rejected, fake.alone], [[], []], "nothing counts against an ARK")
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)

  const asked = fake.asked.length
  await drainer.drain(ALIVE)
  assert.equal(fake.asked.length, asked, "corpus a's turn is paced: not asked again before its backoff")
  down = false
  fake.clock.now += OCR_SYNC_BACKOFF_BASE_MS
  await drainer.drain(ALIVE)
  assert.deepEqual(fake.asked.at(-1), [ark(1), ark(2)])
})

test("A: a whole-worker outage reports worker_unavailable and asks nobody alone on a first failure", async () => {
  const fake = fakePorts({ due: { a: [ark(1)], b: [ark(2)] }, sync: DOWN })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.WORKER_UNAVAILABLE)
  assert.deepEqual(fake.alone, [])
})

test(`A: ARKs whose outage count reached ${OCR_SYNC_ALONE_FROM} are asked ALONE, and their corpus asks no batch meanwhile`, async () => {
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2), ark(3)] },
    outageCount: { [ark(1)]: 2, [ark(2)]: 2, [ark(3)]: 2 },
  })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.asked, [[ark(1)], [ark(2)], [ark(3)]])
})

test("A: an ARK alone that fails AFTER another request was answered this drain is struck (controlled)", async () => {
  const poison = ark(1)
  const fake = fakePorts({
    due: { good: [ark(9)], p1: [poison] },
    outageCount: { [poison]: 2 },
    sync: async (arks) => {
      if (arks.includes(poison)) throw new OcrSyncUnavailableError("worker 502 on this ARK")
      return built(arks)
    },
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.alone, [{ ark: poison, controlled: true }])
  assert.deepEqual(fake.asked, [[ark(9)], [poison]], "the batches go first and prove the worker up")
  assert.equal(report.tally.struck, 1)
})

test("A: with no answer yet, a failure alone asks the CONTROL; an answered control makes it a strike", async () => {
  const poison = ark(1)
  const control = ark(500)
  const fake = fakePorts({
    due: { p1: [poison] },
    outageCount: { [poison]: 2 },
    control,
    sync: async (arks) => {
      if (arks.includes(poison)) throw new OcrSyncUnavailableError("worker 502 on this ARK")
      return built([], { available: [] })
    },
  })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.asked, [[poison], [control]])
  assert.deepEqual(fake.alone, [{ ark: poison, controlled: true }])
})

test("A: a worker outage — the control fails too — strikes nobody and stops asking ARKs alone after two failures", async () => {
  const lone = [ark(1), ark(2), ark(3), ark(4)]
  const fake = fakePorts({
    due: { p1: lone },
    outageCount: Object.fromEntries(lone.map((a) => [a, 2])),
    control: ark(500),
    sync: DOWN,
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.asked, [[ark(1)], [ark(500)]], "one ARK alone and one control, then it stops")
  assert.deepEqual(fake.alone, [{ ark: ark(1), controlled: false }])
  assert.equal(report.tally.struck, 0)
  assert.equal(report.stop, OCR_SYNC_STOP.WORKER_UNAVAILABLE)
})

test("A: with no control available, two ARKs alone failing in a row end the isolation, strike-free", async () => {
  const lone = [ark(1), ark(2), ark(3)]
  const fake = fakePorts({
    due: { p1: lone },
    outageCount: Object.fromEntries(lone.map((a) => [a, 2])),
    control: null,
    sync: DOWN,
  })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.asked, [[ark(1)], [ark(2)]])
  assert.deepEqual(fake.alone, [
    { ark: ark(1), controlled: false },
    { ark: ark(2), controlled: false },
  ])
})

test("A: the isolation budget caps the requests asked alone per drain, the control included", async () => {
  const lone = Array.from({ length: 30 }, (_, i) => ark(i + 1))
  const fake = fakePorts({
    due: { p1: lone },
    outageCount: Object.fromEntries(lone.map((a) => [a, 2])),
  })
  await createOcrSyncDrainer(fake.ports, { ...LIMITS, batchSize: 100 }).drain(ALIVE)
  assert.equal(fake.asked.length, LIMITS.isolationBudget)
})

// --- D: the rotation ------------------------------------------------------------

test("D: twelve resync corpora never starve the others; each tier resumes after the last corpus it served", async () => {
  const corpora: Record<string, string[]> = {}
  const resync: Record<string, number> = {}
  for (let c = 0; c < 12; c++) {
    const id = `r${String(c).padStart(2, "0")}`
    corpora[id] = Array.from({ length: BATCH * 10 }, (_, i) => ark(c * 1000 + i))
    resync[id] = 1
  }
  for (let c = 0; c < 3; c++) corpora[`n${c}`] = Array.from({ length: BATCH * 10 }, (_, i) => ark(90_000 + c * 1000 + i))
  const fake = fakePorts({ due: corpora, resync })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const servedBy = (from: number) =>
    new Set(fake.asked.slice(from).map((b) => (Number(b[0]?.slice(-6)) >= 90_000 ? "n" : "r") + Math.floor((Number(b[0]?.slice(-6)) % 90_000) / 1000)))
  await drainer.drain(ALIVE)
  const first = servedBy(0)
  assert.ok(["n0", "n1", "n2"].every((n) => first.has(n)), `the non-resync corpora are served in the first drain: ${[...first]}`)
  const resyncServed = new Set([...first].filter((id) => id.startsWith("r")))
  for (let i = 0; i < 2; i++) {
    const from = fake.asked.length
    await drainer.drain(ALIVE)
    for (const id of servedBy(from)) if (id.startsWith("r")) resyncServed.add(id)
  }
  assert.equal(resyncServed.size, 12, "every resync corpus served within three drains")
})

test("D: resync-requested corpora go first in a drain", async () => {
  const fake = fakePorts({ due: { a: [ark(1)], b: [ark(2)], z: [ark(3)] }, resync: { z: 1 } })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.asked[0], [ark(3)])
})

test("D: the rest of the rotation resumes after the last corpus served, so the cycle cap starves nobody", async () => {
  const corpora: Record<string, string[]> = {}
  for (let c = 0; c < 12; c++) {
    corpora[`c${String(c).padStart(2, "0")}`] = Array.from({ length: BATCH * 3 }, (_, i) => ark(c * 100 + i))
  }
  const fake = fakePorts({ due: corpora })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  await drainer.drain(ALIVE)
  await drainer.drain(ALIVE)
  const served = new Set(fake.asked.map((b) => Math.floor(Number(b[0]?.slice(-6)) / 100)))
  assert.equal(served.size, 12, "all twelve corpora served within two drains")
})

// --- the drain's limits -------------------------------------------------------------

test("drain: no request starts when its worst-case cost no longer fits the deadline", async () => {
  const fake = fakePorts({ due: { p1: [ark(1)] }, batchCostMs: LIMITS.drainDeadlineMs + 1 })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.BUDGET)
  assert.deepEqual(fake.asked, [])
})

test("drain: every request asked alone passes the cost check too", async () => {
  const fake = fakePorts({ due: { p1: [ark(1), ark(2)] }, outageCount: { [ark(1)]: 2, [ark(2)]: 2 } })
  let cost = 0
  fake.ports.batchCostMs = () => cost
  const sync = fake.ports.syncBatch
  fake.ports.syncBatch = async (arks, signal) => {
    cost = LIMITS.drainDeadlineMs + 1 // after the first request, nothing more fits
    return sync(arks, signal)
  }
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(fake.asked.length, 1)
  assert.equal(report.stop, OCR_SYNC_STOP.BUDGET)
})

test("drain: the deadline cancels the in-flight request and the guard is released after it stopped", async () => {
  const fake = fakePorts({
    due: { p1: [ark(1)] },
    sync: (_arks, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new OcrSyncUnavailableError("cancelled")), { once: true })
      }),
  })
  const drainer = createOcrSyncDrainer(fake.ports, { ...LIMITS, drainDeadlineMs: 30 })
  const report = await drainer.drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DEADLINE)
  assert.deepEqual(fake.batchOutages, [], "our own deadline is nobody's outage")
  assert.equal(drainer.isRunning(), false)
})

test("drain: a trigger during a drain is folded into it (one drain at a time)", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const fake = fakePorts({
    due: { p1: [ark(1)] },
    sync: async (arks) => {
      calls += 1
      await gate
      return built(arks)
    },
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const first = drainer.drain(ALIVE)
  const second = await drainer.drain(ALIVE)
  assert.equal(second.stop, OCR_SYNC_STOP.COALESCED)
  release()
  await first
  assert.equal(calls, 1)
})
