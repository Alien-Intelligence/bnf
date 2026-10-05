// tests/models/documents/ocr-sync-pg.test.ts
// The OCR-quality sync drainer on the REAL ports — DocumentQueries and
// DocumentService against the dev Postgres — under the PRODUCTION limits
// (OCR_SYNC_LIMITS) and the production cadence (one drain every
// OCR_SYNC_SWEEP_INTERVAL_MS of a simulated clock). Only the worker is
// simulated: it is down, fails on one poison ARK, or serves one broken
// artifact. These are the pass-5 fault-model cases (A, B, items 1, 7, 8):
//   - a plain worker outage quarantines nobody, ever, and the corpus is
//     served once the worker is back;
//   - a poison ARK the worker fails on ALONE is quarantined
//     `worker_fails_alone` while its batch-mates are served — also when the
//     app restarts every other drain (all the evidence is persisted);
//   - a lone broken artifact is rejected per ARK and quarantined
//     `sync_rejected`; the sync is never paused for it.
// Each scenario gets its own corpus and ARKs; only its rows are written (a
// control ARK of another test is answered, never written).
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { OCR_SYNC_MAX_ATTEMPTS, OCR_SYNC_SWEEP_INTERVAL_MS } from "@/lib/constants"
import { OcrSyncUnavailableError, type WorkerSyncAnswer } from "@/lib/cluster/ocr-quality"
import {
  OCR_SYNC_LIMITS,
  OCR_SYNC_STOP,
  createOcrSyncDrainer,
  type OcrSyncPorts,
  type OcrSyncStop,
} from "@/lib/documents/ocr-sync"
import { prisma } from "@/lib/db"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { DocumentQueries } from "@/models/documents/queries"
import { OCR_SYNC_STATUS } from "@/models/documents/schema"
import { DocumentService, planOcrSyncWrites } from "@/models/documents/service"

const tag = randomBytes(4).toString("hex")
const ALIVE = new AbortController().signal
const HOUR_OF_DRAINS = Math.round((60 * 60 * 1_000) / OCR_SYNC_SWEEP_INTERVAL_MS)

let userId: string
const projects: string[] = []
const allArks: string[] = []

before(async () => {
  userId = (await createTestUser()).id
})

after(async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: { in: allArks } } })
  for (const id of projects) await cleanupProject(id)
  await deleteTestUser(userId)
})

/** A corpus of `n` indexed ARKs, in ARK order. */
async function corpus(label: string, n: number): Promise<{ projectId: string; arks: string[] }> {
  const projectId = (await createTestProject(userId, `ocr-sync-pg ${label}`)).id
  projects.push(projectId)
  const arks = Array.from({ length: n }, (_, i) => `ark:/12148/zzsync${tag}${label}${String(i).padStart(3, "0")}`)
  allArks.push(...arks)
  await prisma.document.createMany({ data: arks.map((ark) => ({ projectId, ark, indexedAt: new Date() })) })
  return { projectId, arks }
}

/** What the simulated worker does with one request. */
type Worker = (asked: string[]) => "down" | WorkerSyncAnswer

const available = (ark: string) => ({
  v: 1 as const,
  ark,
  ocrRate: 0.9,
  lane: "text" as const,
  folios: [{ ordre: 1, ocrSource: "alto" as const, ocrQuality: 0.9, wordCount: 10 }],
  builtAt: new Date().toISOString(),
})

function answerAll(asked: string[]): WorkerSyncAnswer {
  return { documents: asked.map(available), building: [], unavailable: [], incompatible: [], broken: [] }
}

type Sim = {
  clock: { now: number }
  requests: number
  errors: string[]
  stops: OcrSyncStop[]
  /** Run one drain on a drainer (a fresh one = an app restart), then advance one sweep. */
  sweep(drainer: ReturnType<typeof createOcrSyncDrainer>): Promise<void>
  drainer(): ReturnType<typeof createOcrSyncDrainer>
}

function simulate(projectId: string, mine: string[], worker: { current: Worker }): Sim {
  const sim: Sim = {
    clock: { now: Date.now() },
    requests: 0,
    errors: [],
    stops: [],
    async sweep(drainer) {
      sim.stops.push((await drainer.drain(ALIVE)).stop)
      sim.clock.now += OCR_SYNC_SWEEP_INTERVAL_MS
    },
    drainer: () => createOcrSyncDrainer(ports, OCR_SYNC_LIMITS),
  }
  const ours = new Set(mine)
  const ports: OcrSyncPorts = {
    pendingByCorpus: async (now) =>
      (await DocumentQueries.ocrPendingByCorpus(now)).filter((c) => c.corpusProjectId === projectId),
    pendingArks: (corpusProjectId, limit, now) => DocumentQueries.pendingOcrArks({ corpusProjectId, limit, now }),
    controlArk: (exclude) => DocumentQueries.ocrControlArk(exclude),
    syncBatch: async (arks, signal) => {
      sim.requests += 1
      const askedAt = new Date(sim.clock.now)
      const reply = worker.current(arks)
      if (reply === "down") throw new OcrSyncUnavailableError("worker 502")
      // Only this scenario's rows are written; a control ARK of another
      // test is answered (the worker is up) and left alone.
      const keep = (a: string) => ours.has(a)
      const plan = planOcrSyncWrites(
        { ...reply, documents: reply.documents.filter((d) => keep(d.ark)), broken: reply.broken.filter((b) => keep(b.ark)) },
        askedAt,
      )
      await DocumentService.recordOcrSync(plan, signal)
      return { plan, broken: reply.broken.filter((b) => keep(b.ark)) }
    },
    recordRejection: (ark, message, now, askedAt, signal) =>
      DocumentService.recordOcrRejection(ark, message, now, askedAt, signal),
    recordBatchOutage: (arks, askedAt, signal) => DocumentService.recordOcrBatchOutage(arks, askedAt, signal),
    recordAloneFailure: (ark, message, opts, signal) => DocumentService.recordOcrAloneFailure(ark, message, opts, signal),
    batchCostMs: () => 0,
    now: () => sim.clock.now,
    log: () => {},
    error: (message) => {
      sim.errors.push(message)
    },
  }
  return sim
}

async function rows(arks: string[]) {
  return prisma.documentOcr.findMany({ where: { ark: { in: arks } }, orderBy: { ark: "asc" } })
}

test("item 1: a 3-ARK corpus with the worker DOWN for 48 h — nobody struck or quarantined; all served within an hour of its return", async () => {
  const { projectId, arks } = await corpus("down", 3)
  const worker: { current: Worker } = { current: () => "down" }
  const sim = simulate(projectId, arks, worker)
  const drainer = sim.drainer()
  for (let i = 0; i < 48 * HOUR_OF_DRAINS; i++) await sim.sweep(drainer)
  const during = await rows(arks)
  assert.deepEqual(during.map((r) => r.status), [OCR_SYNC_STATUS.PENDING, OCR_SYNC_STATUS.PENDING, OCR_SYNC_STATUS.PENDING])
  assert.deepEqual(during.map((r) => r.outageStrikes), [0, 0, 0], "no strike without a control")
  assert.deepEqual(during.map((r) => r.syncAttempts), [0, 0, 0])
  assert.ok(sim.requests <= 2 * 48 * HOUR_OF_DRAINS, `at most two requests per drain (${sim.requests})`)
  console.log(`[ocr-sync-pg] worker down 48 h: ${sim.requests} requests over ${48 * HOUR_OF_DRAINS} drains`)

  worker.current = answerAll
  let drains = 0
  while ((await rows(arks)).some((r) => r.status !== OCR_SYNC_STATUS.AVAILABLE)) {
    assert.ok(drains <= HOUR_OF_DRAINS + 1, `served within an hour of the worker's return (drain ${drains})`)
    await sim.sweep(drainer)
    drains += 1
  }
  console.log(`[ocr-sync-pg] worker back: all served after ${drains} drains`)
})

for (const restartEvery of [0, 2]) {
  const label = restartEvery === 0 ? "" : `, the app restarting every ${restartEvery} drains`
  test(`item 1/7: a poison ARK in a 3-ARK corpus${label} — quarantined worker_fails_alone, its batch-mates served`, async () => {
    const { projectId, arks } = await corpus(`poison${restartEvery}`, 3)
    const poison = arks[1] ?? ""
    const worker: { current: Worker } = { current: (asked) => (asked.includes(poison) ? "down" : answerAll(asked)) }
    const sim = simulate(projectId, arks, worker)
    let drainer = sim.drainer()
    let drains = 0
    while ((await rows([poison]))[0]?.status !== OCR_SYNC_STATUS.QUARANTINED) {
      assert.ok(drains < 2 * HOUR_OF_DRAINS, `quarantined within two hours (drain ${drains})`)
      if (restartEvery > 0 && drains % restartEvery === 0) drainer = sim.drainer()
      await sim.sweep(drainer)
      drains += 1
    }
    console.log(`[ocr-sync-pg] poison in 3${label}: quarantined after ${drains} drains (${(drains * OCR_SYNC_SWEEP_INTERVAL_MS) / 60_000} min)`)
    const [first, p, last] = await rows(arks)
    assert.equal(first?.status, OCR_SYNC_STATUS.AVAILABLE)
    assert.equal(last?.status, OCR_SYNC_STATUS.AVAILABLE)
    assert.match(p?.reason ?? "", /^worker_fails_alone: /)
    assert.equal(p?.outageStrikes, OCR_SYNC_MAX_ATTEMPTS, "quarantined at the max, not before")
    const strikeLines = sim.errors.filter((m) => m.startsWith(`${poison}: outage strike`))
    assert.equal(strikeLines.length, OCR_SYNC_MAX_ATTEMPTS, "one true log line per strike")
    assert.match(strikeLines.at(-1) ?? "", new RegExp(`strike ${OCR_SYNC_MAX_ATTEMPTS}/${OCR_SYNC_MAX_ATTEMPTS}, quarantined`))
  })
}

test("A: a poison ARK at position 0 of a full production batch — the other 99 served, the poison quarantined", async () => {
  const { projectId, arks } = await corpus("full", OCR_SYNC_LIMITS.batchSize)
  const poison = arks[0] ?? ""
  const worker: { current: Worker } = { current: (asked) => (asked.includes(poison) ? "down" : answerAll(asked)) }
  const sim = simulate(projectId, arks, worker)
  const drainer = sim.drainer()
  let drains = 0
  const settled = async () => {
    const all = await rows(arks)
    return (
      all.filter((r) => r.status === OCR_SYNC_STATUS.AVAILABLE).length === arks.length - 1 &&
      all.find((r) => r.ark === poison)?.status === OCR_SYNC_STATUS.QUARANTINED
    )
  }
  while (!(await settled())) {
    assert.ok(drains < 3 * HOUR_OF_DRAINS, `settled within three hours (drain ${drains})`)
    await sim.sweep(drainer)
    drains += 1
  }
  // Two batch failures, then the 100 ARKs alone, at most OCR_SYNC_ISOLATION_BUDGET a drain.
  const floor = 2 + Math.ceil(arks.length / OCR_SYNC_LIMITS.isolationBudget)
  assert.ok(drains >= floor, `${drains} drains, at least ${floor} by the budget`)
  assert.ok(sim.stops.every((s) => s !== OCR_SYNC_STOP.EXCHANGE_PAUSED))
  console.log(`[ocr-sync-pg] poison at 0 of ${arks.length}: settled in ${drains} drains (${(drains * OCR_SYNC_SWEEP_INTERVAL_MS) / 60_000} min)`)
})

test("item 8: a lone broken artifact beside a healthy corpus — rejected per ARK, quarantined sync_rejected, the sync never paused", async () => {
  const { projectId, arks } = await corpus("broken", 5)
  const bad = arks[0] ?? ""
  const worker: { current: Worker } = {
    current: (asked) => ({
      ...answerAll(asked.filter((a) => a !== bad)),
      broken: asked.includes(bad) ? [{ ark: bad, message: "duplicate folio 1" }] : [],
    }),
  }
  const sim = simulate(projectId, arks, worker)
  const drainer = sim.drainer()
  let drains = 0
  while ((await rows([bad]))[0]?.status !== OCR_SYNC_STATUS.QUARANTINED) {
    assert.ok(drains < 2 * HOUR_OF_DRAINS, `quarantined within two hours (drain ${drains})`)
    await sim.sweep(drainer)
    drains += 1
  }
  console.log(`[ocr-sync-pg] lone broken artifact: quarantined after ${drains} drains (${(drains * OCR_SYNC_SWEEP_INTERVAL_MS) / 60_000} min)`)
  const all = await rows(arks)
  assert.equal(all.filter((r) => r.status === OCR_SYNC_STATUS.AVAILABLE).length, arks.length - 1)
  assert.match(all.find((r) => r.ark === bad)?.reason ?? "", /^sync_rejected: duplicate folio 1/)
  assert.equal(all.find((r) => r.ark === bad)?.syncAttempts, OCR_SYNC_MAX_ATTEMPTS)
  assert.ok(sim.stops.every((s) => s !== OCR_SYNC_STOP.EXCHANGE_PAUSED), "never paused")
})
