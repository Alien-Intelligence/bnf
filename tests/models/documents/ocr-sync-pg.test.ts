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
/**
 * The dev app may drain this same database in REAL time. Every scenario row is
 * born `pending` with its next check a year ahead (SIM0) and the simulated
 * clock starts there, so a live drainer never sees a scenario ARK as due; a
 * never-answered `pending` row is what a missing row is to the queries.
 */
const SIM0 = Date.now() + 365 * 24 * 60 * 60 * 1_000

let userId: string
const projects: string[] = []
const allArks: string[] = []

before(async () => {
  userId = (await createTestUser()).id
})

after(async () => {
  await prisma.documentFolio.deleteMany({ where: { ark: { in: allArks } } })
  await prisma.documentOcr.deleteMany({ where: { ark: { in: allArks } } })
  for (const id of projects) await cleanupProject(id)
  await deleteTestUser(userId)
})

/** A corpus of `n` indexed ARKs, in ARK order. */
async function corpus(label: string, n: number): Promise<{ projectId: string; arks: string[] }> {
  const projectId = (await createTestProject(userId, `ocr-sync-pg ${label}`)).id
  projects.push(projectId)
  const arks = Array.from({ length: n }, (_, i) => `ark:/12148/zzsync${tag}${label}${String(i).padStart(4, "0")}`)
  allArks.push(...arks)
  await prisma.documentOcr.createMany({
    data: arks.map((ark) => ({ ark, status: OCR_SYNC_STATUS.PENDING, checkedAt: new Date(0), nextCheckAt: new Date(SIM0) })),
  })
  await prisma.document.createMany({ data: arks.map((ark) => ({ projectId, ark, indexedAt: new Date() })) })
  return { projectId, arks }
}

/** Where a request sits: the drain, its rank in the drain, its rank overall. */
type ReqCtx = { drain: number; reqInDrain: number; req: number }
/** What the simulated worker does with one request. */
type Worker = (asked: string[], ctx: ReqCtx) => "down" | WorkerSyncAnswer

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

/** A deterministic PRNG (xorshift32) for the flapping workers. */
function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >> 17
    x ^= x << 5
    x >>>= 0
    return x / 4294967296
  }
}

type Sim = {
  clock: { now: number }
  ctx: ReqCtx
  errors: string[]
  warnings: string[]
  stops: OcrSyncStop[]
  struck: number
  /** Run one drain on a drainer (a fresh one = an app restart), then advance one sweep. */
  sweep(drainer: ReturnType<typeof createOcrSyncDrainer>): Promise<void>
  drainer(): ReturnType<typeof createOcrSyncDrainer>
}

/**
 * The drainer on the REAL ports for the scenario's corpora: only the worker is
 * simulated, and only the scenario's own rows are ever written (a corpus
 * filter on the corpus list, the controls restricted to the scenario's ARKs).
 */
function simulate(projectIds: string[], mine: string[], worker: { current: Worker }): Sim {
  const ours = new Set(mine)
  const keep = (a: string) => ours.has(a)
  const sim: Sim = {
    clock: { now: SIM0 },
    ctx: { drain: 0, reqInDrain: 0, req: 0 },
    errors: [],
    warnings: [],
    stops: [],
    struck: 0,
    async sweep(drainer) {
      sim.ctx.reqInDrain = 0
      const report = await drainer.drain(ALIVE)
      sim.stops.push(report.stop)
      sim.struck += report.tally.struck
      sim.ctx.drain += 1
      sim.clock.now += OCR_SYNC_SWEEP_INTERVAL_MS
    },
    drainer: () => createOcrSyncDrainer(ports, OCR_SYNC_LIMITS),
  }
  const ports: OcrSyncPorts = {
    pendingByCorpus: async (now) =>
      (await DocumentQueries.ocrPendingByCorpus(now)).filter((c) => projectIds.includes(c.corpusProjectId)),
    pendingArks: (corpusProjectId, limit, now) => DocumentQueries.pendingOcrArks({ corpusProjectId, limit, now }),
    controlArks: async (exclude, limit) =>
      (await DocumentQueries.ocrControlArks(exclude, 100_000)).filter(keep).slice(0, limit),
    syncBatch: async (arks, signal) => {
      sim.ctx.req += 1
      sim.ctx.reqInDrain += 1
      const askedAt = new Date(sim.clock.now)
      const reply = worker.current(arks, sim.ctx)
      if (reply === "down") throw new OcrSyncUnavailableError("worker 502")
      const plan = planOcrSyncWrites(
        {
          ...reply,
          documents: reply.documents.filter((d) => keep(d.ark)),
          building: reply.building.filter(keep),
          unavailable: reply.unavailable.filter((u) => keep(u.ark)),
          incompatible: reply.incompatible.filter((i) => keep(i.ark)),
          broken: reply.broken.filter((b) => keep(b.ark)),
        },
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
    warn: (message) => {
      sim.warnings.push(message)
    },
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
  const sim = simulate([projectId], arks, worker)
  const drainer = sim.drainer()
  for (let i = 0; i < 48 * HOUR_OF_DRAINS; i++) await sim.sweep(drainer)
  const during = await rows(arks)
  assert.deepEqual(during.map((r) => r.status), [OCR_SYNC_STATUS.PENDING, OCR_SYNC_STATUS.PENDING, OCR_SYNC_STATUS.PENDING])
  assert.deepEqual(during.map((r) => r.outageStrikes), [0, 0, 0], "no strike without a control")
  assert.deepEqual(during.map((r) => r.syncAttempts), [0, 0, 0])
  assert.ok(sim.ctx.req <= 2 * 48 * HOUR_OF_DRAINS, `at most two requests per drain (${sim.ctx.req})`)
  console.log(`[ocr-sync-pg] worker down 48 h: ${sim.ctx.req} requests over ${48 * HOUR_OF_DRAINS} drains`)

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
    const sim = simulate([projectId], arks, worker)
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
    const strikeLines = sim.warnings.filter((m) => m.startsWith(`${poison}: outage strike`))
    assert.equal(strikeLines.length, OCR_SYNC_MAX_ATTEMPTS, "one true log line per strike")
    assert.match(strikeLines.at(-1) ?? "", new RegExp(`strike ${OCR_SYNC_MAX_ATTEMPTS}/${OCR_SYNC_MAX_ATTEMPTS}, quarantined`))
    assert.equal(sim.warnings.filter((m) => m.includes("outage strike") && !m.startsWith(poison)).length, 0, "no innocent struck")
  })
}

test("A: a poison ARK at position 0 of a full production batch — the other 99 served, the poison quarantined", async () => {
  const { projectId, arks } = await corpus("full", OCR_SYNC_LIMITS.batchSize)
  const poison = arks[0] ?? ""
  const worker: { current: Worker } = { current: (asked) => (asked.includes(poison) ? "down" : answerAll(asked)) }
  const sim = simulate([projectId], arks, worker)
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
  assert.equal(sim.warnings.filter((m) => m.includes("outage strike") && !m.startsWith(poison)).length, 0, "no innocent struck")
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
  const sim = simulate([projectId], arks, worker)
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

// ---------------------------------------------------------------------------
// Pass-6 FAIL 1: a PARTIALLY failing worker must strike nobody innocent.
// Corpora 1000 + 100 + 100, no poison, production limits and cadence.
// ---------------------------------------------------------------------------

/**
 * "A handful": a strike line on an innocent is a WARN, never quarantines it
 * (an answer resets it), and the bar is 0 innocent quarantines; this bounds
 * the noise over 6 h of a 50 %-broken worker.
 */
const FALSE_STRIKE_LINES_MAX = 10

/** Run a flapping worker for `hours` and report what it did to innocent ARKs. */
async function flapping(label: string, hours: number, worker: Worker) {
  const a = await corpus(`${label}a`, 1000)
  const b = await corpus(`${label}b`, 100)
  const c = await corpus(`${label}c`, 100)
  const all = [...a.arks, ...b.arks, ...c.arks]
  const sim = simulate([a.projectId, b.projectId, c.projectId], all, { current: worker })
  const drainer = sim.drainer()
  for (let n = 0; n < hours * HOUR_OF_DRAINS; n++) await sim.sweep(drainer)
  const final = await rows(all)
  const result = {
    quarantined: final.filter((r) => r.status === OCR_SYNC_STATUS.QUARANTINED).length,
    available: final.filter((r) => r.status === OCR_SYNC_STATUS.AVAILABLE).length,
    struckRows: final.filter((r) => r.outageStrikes > 0).length,
    strikeLines: sim.warnings.filter((m) => m.includes("outage strike")).length,
    strikeErrorLines: sim.errors.filter((m) => m.includes("strike")).length,
    requests: sim.ctx.req,
  }
  console.log(`[ocr-sync-pg] flapping ${label} ${hours} h: ${JSON.stringify(result)}`)
  return result
}

test("FAIL 1 alternating up/down worker, 6 h: 0 innocents quarantined, strikes logged at warn only", async () => {
  const r = await flapping("alt", 6, (asked, ctx) => (ctx.req % 2 === 0 ? "down" : answerAll(asked)))
  assert.equal(r.quarantined, 0)
  assert.equal(r.strikeErrorLines, 0)
  assert.ok(r.strikeLines <= FALSE_STRIKE_LINES_MAX, `false strike lines: ${r.strikeLines}`)
})

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`FAIL 1 two replicas, one broken (50 % random, seed ${seed}), 6 h: 0 innocents quarantined`, async () => {
    const random = rng(seed * 7919)
    const r = await flapping(`r${seed}`, 6, (asked) => (random() < 0.5 ? "down" : answerAll(asked)))
    assert.equal(r.quarantined, 0)
    assert.equal(r.strikeErrorLines, 0)
    assert.ok(r.strikeLines <= FALSE_STRIKE_LINES_MAX, `false strike lines: ${r.strikeLines}`)
  })
}

test("FAIL 1 worker dying after the first request of every drain, 6 h: 0 innocents quarantined", async () => {
  const r = await flapping("dies", 6, (asked, ctx) => (ctx.reqInDrain === 1 ? answerAll(asked) : "down"))
  assert.equal(r.quarantined, 0)
  assert.equal(r.strikeErrorLines, 0)
  assert.ok(r.strikeLines <= FALSE_STRIKE_LINES_MAX, `false strike lines: ${r.strikeLines}`)
})

test("FAIL 2 three drainers sharing the database (replicas, a rolling update) — a poison's strikes equal the strikes recorded, never more", async () => {
  const { projectId, arks } = await corpus("three", 3)
  const poison = arks[1] ?? ""
  const worker: { current: Worker } = { current: (asked) => (asked.includes(poison) ? "down" : answerAll(asked)) }
  const sim = simulate([projectId], arks, worker)
  const drainers = [sim.drainer(), sim.drainer(), sim.drainer()]
  let drains = 0
  while ((await rows([poison]))[0]?.status !== OCR_SYNC_STATUS.QUARANTINED) {
    assert.ok(drains < 2 * HOUR_OF_DRAINS, `quarantined within two hours (drain ${drains})`)
    sim.ctx.reqInDrain = 0
    const reports = await Promise.all(drainers.map((d) => d.drain(ALIVE)))
    sim.struck += reports.reduce((n, r) => n + r.tally.struck, 0)
    sim.clock.now += OCR_SYNC_SWEEP_INTERVAL_MS
    drains += 1
  }
  const p = (await rows([poison]))[0]
  assert.equal(p?.outageStrikes, OCR_SYNC_MAX_ATTEMPTS)
  assert.equal(sim.struck, OCR_SYNC_MAX_ATTEMPTS, "every strike recorded once: no double strike, no lost update")
  console.log(`[ocr-sync-pg] three drainers: poison quarantined after ${drains} drains with ${sim.struck} strikes`)
})
