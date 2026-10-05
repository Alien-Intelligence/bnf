// tests/models/documents/ocr-sync.test.ts
// The OCR-quality sync drainer (feedback 2026-09-29 #7, Track B): its pure
// planning, the coverage check that turns an incomplete worker answer into a
// typed contract error, and — through fake ports — its I/O behaviour: culprit
// rejection, bisection, the exchange-level pause and its recovery, the outage
// backoff, the batch budget, deadline cancellation and re-entrancy. The real
// ports (DocumentQueries / DocumentService) are exercised against the dev DB in
// ocr-record.test.ts.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS,
  OCR_SYNC_EXCHANGE_BACKOFF_MAX_MS,
} from "@/lib/constants"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
} from "@/lib/cluster/ocr-quality"
import {
  OCR_SYNC_STOP,
  createOcrSyncDrainer,
  exchangeBackoffMs,
  remainingMs,
  splitBatch,
  type OcrSyncPorts,
} from "@/lib/documents/ocr-sync"
import type { OcrSyncWritePlan } from "@/models/documents/schema"
import { assertSyncCoverage } from "@/models/documents/service"

const ark = (i: number) => `ark:/12148/bpt6k${String(i).padStart(6, "0")}`

test("splitBatch: two halves that cover the batch exactly", () => {
  const arks = [ark(1), ark(2), ark(3), ark(4), ark(5)]
  const [a, b] = splitBatch(arks)
  assert.deepEqual(a, [ark(1), ark(2), ark(3)])
  assert.deepEqual(b, [ark(4), ark(5)])
})

test("splitBatch: repeated halving isolates one ARK in log2(n) steps", () => {
  let batch = Array.from({ length: OCR_SYNC_BATCH_SIZE }, (_, i) => ark(i))
  let steps = 0
  while (batch.length > 1) {
    batch = splitBatch(batch)[1]
    steps += 1
  }
  assert.ok(steps <= Math.ceil(Math.log2(OCR_SYNC_BATCH_SIZE)))
})

test("splitBatch: a single ARK cannot be split (it is the culprit)", () => {
  assert.throws(() => splitBatch([ark(1)]))
})

test("remainingMs: never negative", () => {
  assert.equal(remainingMs(1_000, 400), 600)
  assert.equal(remainingMs(1_000, 5_000), 0)
})

test("assertSyncCoverage: exactly the asked ARKs → ok", () => {
  assert.doesNotThrow(() =>
    assertSyncCoverage([ark(1), ark(2), ark(3)], {
      documents: [
        { v: 1, ark: ark(1), ocrRate: null, lane: "vision", folios: [], builtAt: "2026-10-01T13:49:42.385Z" },
      ],
      building: [ark(2)],
      unavailable: [{ ark: ark(3), reason: "no_pages_artifact" }],
    }),
  )
})

test("assertSyncCoverage: a missing ARK is a contract error pinned on that ARK", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], { documents: [], building: [ark(1)], unavailable: [] }),
    (err: unknown) =>
      err instanceof OcrSyncContractError &&
      err.scope === OCR_SYNC_FAULT_SCOPE.ARKS &&
      err.culprits.join() === ark(2),
  )
})

test("assertSyncCoverage: an ARK nobody asked for is the exchange's fault", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1)], { documents: [], building: [ark(1), ark(9)], unavailable: [] }),
    (err: unknown) =>
      err instanceof OcrSyncContractError && err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE,
  )
})

test("assertSyncCoverage: an answer answering NOTHING of what was asked is the exchange's fault", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], { documents: [], building: [], unavailable: [] }),
    (err: unknown) =>
      err instanceof OcrSyncContractError && err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE && err.culprits.length === 0,
  )
})

test("exchangeBackoffMs: doubles from the base, capped", () => {
  assert.equal(exchangeBackoffMs(1), OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS)
  assert.equal(exchangeBackoffMs(2), 2 * OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS)
  assert.equal(exchangeBackoffMs(30), OCR_SYNC_EXCHANGE_BACKOFF_MAX_MS)
  assert.throws(() => exchangeBackoffMs(0))
})

// ---------------------------------------------------------------------------
// The drainer core through fake ports
// ---------------------------------------------------------------------------

const BATCH = 4

function plan(arks: string[]): OcrSyncWritePlan {
  return { checkedAt: new Date(0), available: [], building: arks, unavailable: [] }
}

type Fake = {
  ports: OcrSyncPorts
  synced: string[][]
  rejected: string[]
  outage: string[][]
  isolated: string[]
  /** Every request the drainer made (batches and sub-batches). */
  asked: string[][]
  clock: { now: number }
  /** ARKs still due, per corpus — a synced/rejected/backed-off ARK leaves the list. */
  due: Map<string, string[]>
}

function fakePorts(opts: {
  due: Record<string, string[]>
  /** ARKs with a resync request, per corpus (they lead the rotation). */
  resync?: Record<string, number>
  sync?: (arks: string[], signal: AbortSignal) => Promise<OcrSyncWritePlan>
  batchCostMs?: number
}): Fake {
  const synced: string[][] = []
  const rejected: string[] = []
  const outage: string[][] = []
  const isolated: string[] = []
  const asked: string[][] = []
  const clock = { now: 1_000_000 }
  const due = new Map(Object.entries(opts.due))
  const settle = (arks: string[]) => {
    for (const [corpus, list] of due) due.set(corpus, list.filter((a) => !arks.includes(a)))
  }
  const ports: OcrSyncPorts = {
    pendingByCorpus: async () =>
      [...due].map(([corpusProjectId, list]) => ({
        corpusProjectId,
        pending: list.length,
        resync: opts.resync?.[corpusProjectId] ?? 0,
      })),
    pendingArks: async (corpusProjectId, limit) => {
      const list = due.get(corpusProjectId)
      if (list === undefined) throw new Error(`unknown corpus ${corpusProjectId}`)
      return list.slice(0, limit)
    },
    syncBatch: async (arks, signal) => {
      asked.push(arks)
      const result = opts.sync ? await opts.sync(arks, signal) : plan(arks)
      synced.push(arks)
      settle(arks)
      return result
    },
    recordRejection: async (a) => {
      rejected.push(a)
      settle([a])
    },
    // Never-asked ARKs (the fake's model) have no row to back off: an outage
    // leaves them due, exactly as in production.
    recordOutage: async (arks) => {
      outage.push(arks)
    },
    recordIsolation: async (a) => {
      isolated.push(a)
      settle([a])
    },
    batchCostMs: () => opts.batchCostMs ?? 0,
    now: () => clock.now,
    log: () => {},
    error: () => {},
  }
  return { ports, synced, rejected, outage, isolated, asked, clock, due }
}

const LIMITS = {
  drainDeadlineMs: 60_000,
  batchSize: BATCH,
  maxBatches: 10,
  outageBisectBudget: 16,
  maxAttempts: 3,
  outageBackoffMs: 30 * 60 * 1_000,
}
const ALIVE = new AbortController().signal

test("drain: syncs every due ARK of every corpus, round-robin, one batch per corpus per round", async () => {
  const fake = fakePorts({ due: { p1: [ark(1), ark(2), ark(3), ark(4), ark(5)], p2: [ark(6)] } })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
  assert.deepEqual(fake.synced, [[ark(1), ark(2), ark(3), ark(4)], [ark(6)], [ark(5)]])
  assert.equal(report.tally.building, 6)
})

test("drain: a big backlog never starves another corpus; corpora with resync requests go first", async () => {
  const big = Array.from({ length: 40 }, (_, i) => ark(100 + i))
  const fake = fakePorts({
    due: { big, fresh: [ark(1)] },
    resync: { fresh: 1 },
  })
  await createOcrSyncDrainer(fake.ports, { ...LIMITS, maxBatches: 3 }).drain(ALIVE)
  assert.deepEqual(fake.synced[0], [ark(1)], "the fresh corpus's resync first")
  assert.equal(fake.synced.length, 3)
})

test("drain: named culprits are rejected and the rest of the batch asked again", async () => {
  const poison = ark(2)
  const fake = fakePorts({
    due: { p1: [ark(1), poison, ark(3)] },
    sync: async (arks) => {
      if (arks.includes(poison)) {
        throw new OcrSyncContractError("arks[1] refused", { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits: [poison] })
      }
      return plan(arks)
    },
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.rejected, [poison])
  assert.deepEqual(fake.synced, [[ark(1), ark(3)]])
  assert.equal(report.tally.rejected, 1)
})

test("drain: an unnamed ARK-level break is isolated by bisection", async () => {
  const poison = ark(3)
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2), poison, ark(4)] },
    sync: async (arks) => {
      if (arks.includes(poison)) {
        throw new OcrSyncContractError("bad entry", { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits: [] })
      }
      return plan(arks)
    },
  })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.rejected, [poison])
  assert.deepEqual(fake.synced.flat().sort(), [ark(1), ark(2), ark(4)].sort())
})

test("drain: an exchange-level break pauses the sync without penalising any ARK, then recovers", async () => {
  let broken = true
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2)] },
    sync: async (arks) => {
      if (broken) throw new OcrSyncContractError("401", { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] })
      return plan(arks)
    },
  })
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  const first = await drainer.drain(ALIVE)
  assert.equal(first.stop, OCR_SYNC_STOP.EXCHANGE_PAUSED)
  assert.deepEqual(fake.rejected, [])
  assert.equal(drainer.pausedUntil(), fake.clock.now + OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS)

  const stillPaused = await drainer.drain(ALIVE)
  assert.equal(stillPaused.stop, OCR_SYNC_STOP.EXCHANGE_PAUSED, "no request while paused")

  broken = false
  fake.clock.now += OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS
  const recovered = await drainer.drain(ALIVE)
  assert.equal(recovered.stop, OCR_SYNC_STOP.DONE)
  assert.equal(drainer.pausedUntil(), 0)
  assert.deepEqual(fake.synced, [[ark(1), ark(2)]])
})

test("drain: an outage ends that corpus's turn only — other corpora are still served", async () => {
  const fake = fakePorts({
    due: { a: [ark(1), ark(2)], b: [ark(3)] },
    sync: async (arks) => {
      if (arks.includes(ark(1))) throw new OcrSyncUnavailableError("502")
      return plan(arks)
    },
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.outage, [[ark(1), ark(2)]])
  assert.deepEqual(fake.synced, [[ark(3)]], "corpus b is served despite a's outage")
  assert.deepEqual(fake.rejected, [], "an outage never counts against an ARK's contract budget")
  assert.equal(report.stop, OCR_SYNC_STOP.DONE)
})

test("drain: a whole-worker outage reports worker_unavailable", async () => {
  const fake = fakePorts({
    due: { a: [ark(1)], b: [ark(2)] },
    sync: async () => {
      throw new OcrSyncUnavailableError("ECONNREFUSED")
    },
  })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.WORKER_UNAVAILABLE)
})

test("drain: no batch starts when its worst-case cost no longer fits the deadline", async () => {
  const fake = fakePorts({ due: { p1: [ark(1)] }, batchCostMs: LIMITS.drainDeadlineMs + 1 })
  const report = await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.BUDGET)
  assert.deepEqual(fake.synced, [])
})

test("drain: the deadline cancels the in-flight request and the guard is released after it stopped", async () => {
  const fake = fakePorts({
    due: { p1: [ark(1)] },
    sync: (_arks, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new OcrSyncUnavailableError("cancelled")), {
          once: true,
        })
      }),
  })
  const drainer = createOcrSyncDrainer(fake.ports, { ...LIMITS, drainDeadlineMs: 30 })
  const report = await drainer.drain(ALIVE)
  assert.equal(report.stop, OCR_SYNC_STOP.DEADLINE)
  assert.deepEqual(fake.outage, [], "our own deadline penalises nobody")
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
      return plan(arks)
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

test("drain: a poison ARK at position 0 of 300 is isolated within a few drains and the other 299 are served", async () => {
  const arks = Array.from({ length: 300 }, (_, i) => ark(1000 + i))
  const poison = arks[0]
  const fake = fakePorts({
    due: { p1: [...arks] },
    sync: async (batch) => {
      if (batch.includes(poison)) throw new OcrSyncUnavailableError("worker 502 on this ARK")
      return plan(batch)
    },
  })
  const limits = { ...LIMITS, batchSize: 100, maxBatches: 10 }
  const drainer = createOcrSyncDrainer(fake.ports, limits)
  let drains = 0
  while (drains < 12 && (fake.due.get("p1")?.length ?? 0) > 0) {
    await drainer.drain(ALIVE)
    drains += 1
    fake.clock.now += limits.outageBackoffMs // the benched poison is due again next drain
  }
  assert.deepEqual(fake.isolated, [poison], "the poison ARK is isolated")
  assert.equal(fake.synced.flat().length, 299, "every other ARK is served")
  assert.ok(drains <= 6, `isolated within ${drains} drains`)
})

test("drain: bisection asks BOTH halves and never exceeds its per-drain request budget", async () => {
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2), ark(3), ark(4)] },
    sync: async () => {
      throw new OcrSyncUnavailableError("down")
    },
  })
  const drainer = createOcrSyncDrainer(fake.ports, { ...LIMITS, outageBisectBudget: 2 })
  await drainer.drain(ALIVE)
  const before = fake.asked.length
  await drainer.drain(ALIVE)
  assert.deepEqual(
    fake.asked.slice(before),
    [[ark(1), ark(2), ark(3), ark(4)], [ark(1), ark(2)], [ark(3), ark(4)]],
    "one split (budget 2): both halves asked, no deeper",
  )
})

test("drain: every request, bisected sub-batches included, passes the batch-cost check", async () => {
  let cost = 0
  const fake = fakePorts({
    due: { p1: [ark(1), ark(2), ark(3), ark(4)] },
    sync: async () => {
      cost = LIMITS.drainDeadlineMs + 1 // after the first request, nothing more fits
      throw new OcrSyncUnavailableError("down")
    },
  })
  fake.ports.batchCostMs = () => cost
  const drainer = createOcrSyncDrainer(fake.ports, LIMITS)
  await drainer.drain(ALIVE) // first outage, counted
  cost = 0
  const before = fake.asked.length
  const report = await drainer.drain(ALIVE)
  assert.equal(fake.asked.length - before, 1, "the sub-batches did not start")
  assert.equal(report.stop, OCR_SYNC_STOP.BUDGET)
})

test("drain: the rotation resumes after the last corpus served, so a cycle cap starves nobody", async () => {
  const corpora: Record<string, string[]> = {}
  for (let c = 0; c < 12; c++) {
    corpora[`c${String(c).padStart(2, "0")}`] = Array.from({ length: BATCH * 3 }, (_, i) => ark(c * 100 + i))
  }
  const fake = fakePorts({ due: corpora })
  const drainer = createOcrSyncDrainer(fake.ports, { ...LIMITS, maxBatches: 10 })
  await drainer.drain(ALIVE)
  await drainer.drain(ALIVE)
  const served = new Set(fake.synced.map((b) => Math.floor(Number(b[0]?.slice(-6)) / 100)))
  assert.equal(served.size, 12, "all twelve corpora served within two cycles")
})

test("drain: resync-requested corpora still go first, whatever the cursor", async () => {
  const fake = fakePorts({ due: { a: [ark(1)], b: [ark(2)], z: [ark(3)] }, resync: { z: 1 } })
  await createOcrSyncDrainer(fake.ports, LIMITS).drain(ALIVE)
  assert.deepEqual(fake.synced[0], [ark(3)])
})
