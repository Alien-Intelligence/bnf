// tests/models/documents/ocr-record.test.ts
// DocumentService's OCR-quality writes and DocumentQueries' OCR reads against
// the dev Postgres (the lib/testing/fixtures.ts convention: the SQL is the
// thing under test, so it is not mocked). Feedback 2026-09-29 #7, Track B.
//
// What it guards:
//   - an available ARK's folios are REPLACED wholesale and a replay is
//     idempotent; building / unavailable answers keep the folios;
//   - pendingOcrArks: only indexed ARKs; a row is offered again only when due
//     (next_check_at), a resync request makes an available row due;
//   - a rejected ARK backs off and is quarantined after
//     OCR_SYNC_MAX_ATTEMPTS, after which the sweep no longer offers it;
//   - the evidence model's writes (pass 5 A–C): a batch outage counts against
//     nobody and leaves the row due; an ARK alone is struck only with a
//     control, quarantined `worker_fails_alone` at OCR_SYNC_MAX_ATTEMPTS
//     strikes, never when `available`; every failure write is superseded by an
//     answer recorded after its question and never erases a resync requested
//     in flight; an incompatible artifact blames nobody;
//   - every user-facing read is gated on the reader's corpus: an ARK outside
//     it reads as nothing, even with stored rows (plan D8).
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import {
  OCR_SYNC_BACKOFF_BASE_MS,
  OCR_SYNC_INCOMPATIBLE_RECHECK_MS,
  OCR_SYNC_MAX_ATTEMPTS,
  OCR_SYNC_QUARANTINE_RECHECK_BASE_MS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { DocumentQueries } from "@/models/documents/queries"
import {
  OCR_SOURCE,
  OCR_SYNC_STATUS,
  type OcrSyncWritePlan,
} from "@/models/documents/schema"
import { DocumentService, OCR_ALONE_OUTCOME } from "@/models/documents/service"

const tag = randomBytes(4).toString("hex")
const ARK_A = `ark:/12148/zzocr${tag}a`
const ARK_B = `ark:/12148/zzocr${tag}b`
const ARK_C = `ark:/12148/zzocr${tag}c` // in the corpus, never indexed
const ARK_OUT = `ark:/12148/zzocr${tag}x` // in NO corpus of this test
const TEST_ARKS = [ARK_A, ARK_B, ARK_C, ARK_OUT]
/** Large enough to cover every indexed ARK in the dev DB, so ordering does not hide ours. */
const ALL = 1_000_000

let userId: string
let projectId: string

function plan(over: Partial<OcrSyncWritePlan>): OcrSyncWritePlan {
  return { checkedAt: new Date(), available: [], building: [], unavailable: [], incompatible: [], ...over }
}

async function pendingAt(now: Date): Promise<string[]> {
  const due = await DocumentQueries.pendingOcrArks({ corpusProjectId: projectId, limit: ALL, now })
  return due.map((d) => d.ark)
}

const ALIVE = new AbortController().signal

const LATER = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000)

before(async () => {
  userId = (await createTestUser()).id
  projectId = (await createTestProject(userId, "ocr-record")).id
  const indexedAt = new Date()
  await prisma.document.createMany({
    data: [
      { projectId, ark: ARK_A, indexedAt },
      { projectId, ark: ARK_B, indexedAt },
      { projectId, ark: ARK_C, indexedAt: null },
    ],
  })
})

after(async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: { in: TEST_ARKS } } })
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

test("pendingOcrArks: indexed ARKs without a row are pending; unindexed ones never", async () => {
  const pending = await pendingAt(new Date())
  assert.ok(pending.includes(ARK_A))
  assert.ok(pending.includes(ARK_B))
  assert.ok(!pending.includes(ARK_C))
})

test("recordOcrSync: available stores the folios; building stores a status", async () => {
  await DocumentService.recordOcrSync(
    plan({
      available: [
        {
          ark: ARK_A,
          ocrRate: 0.7821,
          folios: [
            { folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.932, wordCount: 5106 },
            { folio: 2, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.661, wordCount: 4016 },
          ],
        },
      ],
      building: [ARK_B],
    }), ALIVE)
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(a?.ocrRate, 0.7821)
  assert.equal(a?.folios.length, 2)
  const b = await DocumentQueries.ocrForArk(projectId, ARK_B)
  assert.equal(b?.status, OCR_SYNC_STATUS.BUILDING)
  assert.equal(b?.folios.length, 0)
})

test("ocrIndexRows: only the asked (ark, folio) pairs that exist, plus document statuses", async () => {
  const rows = await DocumentQueries.ocrIndexRows(projectId, [
    { ark: ARK_A, folio: 2 },
    { ark: ARK_A, folio: 3 },
    { ark: ARK_B, folio: 1 },
  ])
  assert.deepEqual(
    rows.folios.map((r) => [r.ark, r.folio, r.ocrQuality]),
    [[ARK_A, 2, 0.661]],
  )
  assert.deepEqual(
    rows.documents.map((d) => [d.ark, d.status]).sort(),
    [
      [ARK_A, OCR_SYNC_STATUS.AVAILABLE],
      [ARK_B, OCR_SYNC_STATUS.BUILDING],
    ],
  )
})

test("corpus gate: an ARK outside the reader's corpus reads as nothing, even when stored", async () => {
  await DocumentService.recordOcrSync(
    plan({
      available: [
        {
          ark: ARK_OUT,
          ocrRate: 0.5,
          folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.2, wordCount: 10 }],
        },
      ],
    }), ALIVE)
  assert.equal(await DocumentQueries.ocrForArk(projectId, ARK_OUT), null)
  assert.deepEqual(await DocumentQueries.ocrForArks(projectId, [ARK_OUT]), [])
  assert.deepEqual(await DocumentQueries.ocrIndexRows(projectId, [{ ark: ARK_OUT, folio: 1 }]), {
    folios: [],
    documents: [],
  })
})

test("pendingOcrArks: available is not due; building is due only after its next check", async () => {
  const pending = await pendingAt(new Date())
  assert.ok(!pending.includes(ARK_A), "available ARK is not pending")
  assert.ok(!pending.includes(ARK_B), "building ARK checked just now is not due")
  const later = await pendingAt(LATER())
  assert.ok(!later.includes(ARK_A), "available is never re-offered without a resync request")
  assert.ok(later.includes(ARK_B), "building ARK is due once its recheck time passed")
})

test("ocrResyncOp: a re-ingest makes an available ARK due now; an answer clears it", async () => {
  await DocumentService.ocrResyncOp([ARK_A], new Date())
  assert.ok((await pendingAt(new Date())).includes(ARK_A), "resync request makes it due")
  await DocumentService.recordOcrSync(
    plan({
      available: [
        {
          ark: ARK_A,
          ocrRate: 0.8,
          folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.95, wordCount: 5000 }],
        },
      ],
    }), ALIVE)
  const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_A } })
  assert.equal(row.resyncRequestedAt, null)
  assert.equal(row.nextCheckAt, null)
  assert.ok(!(await pendingAt(new Date())).includes(ARK_A))
})

test("recordOcrSync: a re-OCR replaces the folios wholesale; a replay is idempotent", async () => {
  const reocr = plan({
    available: [
      {
        ark: ARK_A,
        ocrRate: 0.8,
        folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.95, wordCount: 5000 }],
      },
    ],
  })
  await DocumentService.recordOcrSync(reocr, ALIVE)
  await DocumentService.recordOcrSync(reocr, ALIVE)
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.deepEqual(
    a?.folios.map((f) => [f.folio, f.ocrQuality]),
    [[1, 0.95]],
  )
})

test("FAIL 4 recordOcrSync: an `unavailable` answer (artifact_corrupt while the worker rebuilds) leaves an available row available", async () => {
  await DocumentService.recordOcrSync(
    plan({ unavailable: [{ ark: ARK_A, reason: "artifact_corrupt" }] }), ALIVE)
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(a?.reason, null)
  assert.equal(a?.folios.length, 1)
})

test("recordOcrSync: unavailable records the reason on a row that was not available", async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_B } })
  await DocumentService.recordOcrSync(plan({ unavailable: [{ ark: ARK_B, reason: "no_pages_artifact" }] }), ALIVE)
  const b = await DocumentQueries.ocrForArk(projectId, ARK_B)
  assert.equal(b?.status, OCR_SYNC_STATUS.UNAVAILABLE)
  assert.equal(b?.reason, "no_pages_artifact")
})

test("recordOcrRejection: backs off, then quarantines on the long backoff after OCR_SYNC_MAX_ATTEMPTS", async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_B } })
  const base = Date.now()
  for (let i = 1; i < OCR_SYNC_MAX_ATTEMPTS; i += 1) {
    const askedAt = new Date(base + i * 10)
    await DocumentService.recordOcrRejection(ARK_B, "worker refused", askedAt, askedAt, ALIVE)
    const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
    assert.equal(row.syncAttempts, i)
    assert.equal(row.status, OCR_SYNC_STATUS.UNAVAILABLE)
    assert.ok(row.nextCheckAt !== null && row.nextCheckAt > new Date(), "backs off into the future")
    assert.ok(!(await pendingAt(new Date())).includes(ARK_B), "not offered while backing off")
  }
  const lastAsked = new Date(base + OCR_SYNC_MAX_ATTEMPTS * 10)
  await DocumentService.recordOcrRejection(ARK_B, "worker refused", lastAsked, lastAsked, ALIVE)
  const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
  assert.equal(row.status, OCR_SYNC_STATUS.QUARANTINED)
  assert.equal(row.nextCheckAt?.getTime(), lastAsked.getTime() + OCR_SYNC_QUARANTINE_RECHECK_BASE_MS)
  assert.ok(row.reason !== null && /^sync_rejected: worker refused/.test(row.reason))
  assert.ok(!(await pendingAt(at(lastAsked, 23 * 60))).includes(ARK_B), "not offered within the day")
  assert.ok((await pendingAt(LATER())).includes(ARK_B), "but asked again: quarantine is never terminal")

  await DocumentService.ocrResyncOp([ARK_B], new Date())
  const resynced = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
  assert.equal(resynced.syncAttempts, 0, "a re-ingest gives it a fresh attempt budget")
  assert.ok((await pendingAt(new Date())).includes(ARK_B))
})

test("recordOcrRejection: an available row keeps its status and folios while backing off", async () => {
  await DocumentService.recordOcrSync(
    plan({
      available: [
        {
          ark: ARK_A,
          ocrRate: 0.8,
          folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.95, wordCount: 5000 }],
        },
      ],
    }), ALIVE)
  const askedAt = new Date(Date.now() + 1_000)
  await DocumentService.recordOcrRejection(ARK_A, "bad answer", askedAt, askedAt, ALIVE)
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(a?.reason, null)
  assert.equal(a?.folios.length, 1)
})

test("isIndexedInCorpus: indexed in this corpus only", async () => {
  assert.equal(await DocumentQueries.isIndexedInCorpus(projectId, ARK_A), true)
  assert.equal(await DocumentQueries.isIndexedInCorpus(projectId, ARK_C), false)
  assert.equal(await DocumentQueries.isIndexedInCorpus("no-such-project", ARK_A), false)
})

test("ocrPendingByCorpus: names the corpus with due work, never an ARK", async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_A } })
  const rows = await DocumentQueries.ocrPendingByCorpus(new Date())
  const mine = rows.find((r) => r.corpusProjectId === projectId)
  assert.ok(mine !== undefined && mine.pending >= 1)
  assert.deepEqual(Object.keys(mine).sort(), ["corpusProjectId", "pending", "resync"])
})

for (const answer of ["building", "unavailable"] as const) {
  test(`a resync requested while the question is in flight stays due after a ${answer} answer`, async () => {
    await prisma.documentOcr.deleteMany({ where: { ark: ARK_A } })
    await prisma.documentOcr.create({
      data: { ark: ARK_A, status: OCR_SYNC_STATUS.AVAILABLE, checkedAt: new Date(0) },
    })
    const askedAt = new Date(Date.now() - 1_000)
    await DocumentService.ocrResyncOp([ARK_A], new Date())
    await DocumentService.recordOcrSync(
      {
        checkedAt: askedAt,
        available: [],
        building: answer === "building" ? [ARK_A] : [],
        unavailable: answer === "unavailable" ? [{ ark: ARK_A, reason: "no_pages_artifact" }] : [],
        incompatible: [],
      },
      ALIVE,
    )
    const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_A } })
    assert.ok(row.resyncRequestedAt !== null, "the request is kept")
    assert.ok(row.nextCheckAt !== null && row.nextCheckAt <= new Date(), "and stays due now")
    assert.ok((await pendingAt(new Date())).includes(ARK_A))
  })
}

test("a resync requested while the question is in flight stays due after the answer", async () => {
  const askedAt = new Date(Date.now() - 1_000)
  await DocumentService.ocrResyncOp([ARK_A], new Date())
  await DocumentService.recordOcrSync(
    {
      checkedAt: askedAt,
      available: [
        {
          ark: ARK_A,
          ocrRate: 0.8,
          folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.95, wordCount: 5000 }],
        },
      ],
      building: [],
      unavailable: [],
      incompatible: [],
    },
    ALIVE,
  )
  const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_A } })
  assert.ok(row.resyncRequestedAt !== null, "the newer request is kept")
  assert.ok((await pendingAt(new Date())).includes(ARK_A), "and the ARK is due again")
})

test("recordOcrSync stops between ARKs once the drain is aborted", async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    DocumentService.recordOcrSync(plan({ building: [ARK_B] }), aborted.signal),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  )
})


test("a resync beats a quarantine: one requested mid-flight survives the quarantining rejection, and a resync re-opens a quarantined ARK", async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_B } })
  await prisma.documentOcr.create({
    data: { ark: ARK_B, status: OCR_SYNC_STATUS.UNAVAILABLE, checkedAt: new Date(0), syncAttempts: OCR_SYNC_MAX_ATTEMPTS - 1 },
  })
  const askedAt = new Date(Date.now() - 1_000)
  await DocumentService.ocrResyncOp([ARK_B], new Date()) // requested while in flight
  await prisma.documentOcr.update({ where: { ark: ARK_B }, data: { syncAttempts: OCR_SYNC_MAX_ATTEMPTS - 1 } })
  await DocumentService.recordOcrRejection(ARK_B, "worker refused", new Date(), askedAt, ALIVE)
  let row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
  assert.equal(row.status, OCR_SYNC_STATUS.QUARANTINED)
  assert.ok(row.resyncRequestedAt !== null, "quarantine never erases a resync request")
  assert.ok((await pendingAt(new Date())).includes(ARK_B), "and the ARK stays due")

  // A quarantine with no pending resync is out of the rotation…
  await prisma.documentOcr.update({ where: { ark: ARK_B }, data: { resyncRequestedAt: null, nextCheckAt: null } })
  assert.ok(!(await pendingAt(new Date())).includes(ARK_B))
  // …until a re-ingest's resync re-opens it with a fresh budget.
  await DocumentService.ocrResyncOp([ARK_B], new Date())
  row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
  assert.equal(row.syncAttempts, 0)
  assert.ok((await pendingAt(new Date())).includes(ARK_B))
})

// ---------------------------------------------------------------------------
// The evidence model's writes (pass 5)
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE)

async function reset(ark: string): Promise<void> {
  await prisma.documentOcr.deleteMany({ where: { ark } })
}

async function rowOf(ark: string) {
  return prisma.documentOcr.findUniqueOrThrow({ where: { ark } })
}

async function availableRow(ark: string, syncedAt: Date): Promise<void> {
  await reset(ark)
  await DocumentService.recordOcrSync(
    plan({
      checkedAt: syncedAt,
      available: [{ ark, ocrRate: 0.8, folios: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.95, wordCount: 50 }] }],
    }),
    ALIVE,
  )
}

test("A recordOcrBatchOutage: a never-asked ARK gets a due `pending` row; nothing counts against it", async () => {
  await reset(ARK_A)
  const askedAt = new Date()
  await DocumentService.recordOcrBatchOutage([ARK_A], askedAt, ALIVE)
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.PENDING)
  assert.equal(row.outageCount, 1)
  assert.deepEqual([row.syncAttempts, row.outageStrikes], [0, 0])
  assert.ok((await pendingAt(new Date())).includes(ARK_A), "still due: an outage says nothing about it")
  assert.equal((await DocumentQueries.ocrForArk(projectId, ARK_A))?.status, OCR_SYNC_STATUS.PENDING)
})

test("A recordOcrBatchOutage: an existing row keeps its status, budget and next check; only its count moves", async () => {
  await reset(ARK_A)
  const next = LATER()
  await prisma.documentOcr.create({
    data: { ark: ARK_A, status: OCR_SYNC_STATUS.BUILDING, checkedAt: new Date(0), syncAttempts: 2, nextCheckAt: next },
  })
  await DocumentService.recordOcrBatchOutage([ARK_A], new Date(), ALIVE)
  const row = await rowOf(ARK_A)
  assert.deepEqual(
    [row.status, row.syncAttempts, row.outageCount, row.nextCheckAt?.getTime()],
    [OCR_SYNC_STATUS.BUILDING, 2, 1, next.getTime()],
  )
})

test("C recordOcrBatchOutage: a row answered after the question was asked is not counted", async () => {
  const askedAt = new Date(Date.now() - MINUTE)
  await availableRow(ARK_A, new Date())
  await DocumentService.recordOcrBatchOutage([ARK_A], askedAt, ALIVE)
  assert.equal((await rowOf(ARK_A)).outageCount, 0)
})

test("A recordOcrAloneFailure without a control: backs off by the outage count, never a strike", async () => {
  await reset(ARK_A)
  const askedAt = new Date()
  await DocumentService.recordOcrBatchOutage([ARK_A], askedAt, ALIVE)
  await DocumentService.recordOcrBatchOutage([ARK_A], askedAt, ALIVE)
  const now = new Date()
  for (let i = 0; i < OCR_SYNC_MAX_ATTEMPTS + 2; i++) {
    const asked = at(askedAt, i)
    const r = await DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt: asked, now: asked, bracketed: false }, ALIVE)
    assert.deepEqual(r, { outcome: OCR_ALONE_OUTCOME.BACKOFF, strikes: 0 })
  }
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.PENDING, "a worker outage quarantines nobody")
  assert.equal(row.outageStrikes, 0)
  assert.ok(row.nextCheckAt !== null && row.nextCheckAt > now)
})

test("A recordOcrAloneFailure with a control: strikes, then quarantines `worker_fails_alone` at OCR_SYNC_MAX_ATTEMPTS", async () => {
  await reset(ARK_A)
  const base = new Date()
  await DocumentService.recordOcrBatchOutage([ARK_A], base, ALIVE)
  for (let i = 1; i <= OCR_SYNC_MAX_ATTEMPTS; i++) {
    const askedAt = at(base, i * 60)
    const r = await DocumentService.recordOcrAloneFailure(ARK_A, "worker 502 on it", { askedAt, now: askedAt, bracketed: true }, ALIVE)
    const row = await rowOf(ARK_A)
    assert.equal(r.strikes, i)
    assert.equal(row.outageStrikes, i)
    if (i < OCR_SYNC_MAX_ATTEMPTS) {
      assert.equal(r.outcome, OCR_ALONE_OUTCOME.STRUCK)
      assert.equal(row.status, OCR_SYNC_STATUS.PENDING)
      assert.ok(row.nextCheckAt !== null && row.nextCheckAt > askedAt)
    } else {
      assert.equal(r.outcome, OCR_ALONE_OUTCOME.QUARANTINED)
      assert.equal(row.status, OCR_SYNC_STATUS.QUARANTINED)
      assert.match(row.reason ?? "", /^worker_fails_alone: worker 502 on it/)
      assert.equal(row.nextCheckAt?.getTime(), askedAt.getTime() + OCR_SYNC_QUARANTINE_RECHECK_BASE_MS)
    }
  }
  assert.ok((await pendingAt(LATER())).includes(ARK_A), "a quarantine is a long backoff, never terminal")
  await DocumentService.ocrResyncOp([ARK_A], new Date())
  const reopened = await rowOf(ARK_A)
  assert.deepEqual([reopened.outageStrikes, reopened.outageCount], [0, 0], "a resync gives a fresh budget")
  assert.ok((await pendingAt(new Date())).includes(ARK_A))
})

test("C recordOcrAloneFailure: an `available` row is NEVER quarantined by strikes", async () => {
  const base = new Date(Date.now() - 24 * 60 * MINUTE)
  await availableRow(ARK_A, base)
  for (let i = 1; i <= OCR_SYNC_MAX_ATTEMPTS + 2; i++) {
    const askedAt = at(base, i)
    await DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt, now: askedAt, bracketed: true }, ALIVE)
  }
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal((await DocumentQueries.ocrForArk(projectId, ARK_A))?.folios.length, 1)
  assert.ok(row.nextCheckAt !== null, "it only backs off")
})

test("C recordOcrAloneFailure: a resync requested in flight survives the quarantining strike", async () => {
  await reset(ARK_A)
  const askedAt = new Date(Date.now() - MINUTE)
  await DocumentService.recordOcrBatchOutage([ARK_A], new Date(Date.now() - 2 * MINUTE), ALIVE)
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { outageStrikes: OCR_SYNC_MAX_ATTEMPTS - 1 } })
  await DocumentService.ocrResyncOp([ARK_A], new Date()) // after askedAt: in flight
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { outageStrikes: OCR_SYNC_MAX_ATTEMPTS - 1 } })
  const r = await DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt, now: new Date(), bracketed: true }, ALIVE)
  assert.equal(r.outcome, OCR_ALONE_OUTCOME.QUARANTINED)
  const row = await rowOf(ARK_A)
  assert.ok(row.resyncRequestedAt !== null, "the request is kept")
  assert.ok(row.nextCheckAt !== null && row.nextCheckAt <= new Date(), "and the ARK stays due")
  assert.ok((await pendingAt(new Date())).includes(ARK_A))
})

test("C recordOcrAloneFailure: an answer recorded after the question supersedes it (nothing written)", async () => {
  const askedAt = new Date(Date.now() - MINUTE)
  await availableRow(ARK_A, new Date())
  const before = await rowOf(ARK_A)
  const r = await DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt, now: new Date(), bracketed: true }, ALIVE)
  assert.equal(r.outcome, OCR_ALONE_OUTCOME.STALE)
  assert.deepEqual(await rowOf(ARK_A), before)
})

test("C recordOcrRejection: a rejection of a question older than the stored answer changes nothing — an available row stays available", async () => {
  const askedAt = new Date(Date.now() - MINUTE)
  await availableRow(ARK_A, new Date())
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { syncAttempts: OCR_SYNC_MAX_ATTEMPTS - 1 } })
  const before = await rowOf(ARK_A)
  await DocumentService.recordOcrRejection(ARK_A, "duplicate folio", new Date(), askedAt, ALIVE)
  assert.deepEqual(await rowOf(ARK_A), before)
})

test("C recordOcrRejection: the rejection of a NEW answer may quarantine an available row (folios kept)", async () => {
  const synced = new Date(Date.now() - 10 * MINUTE)
  await availableRow(ARK_A, synced)
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { syncAttempts: OCR_SYNC_MAX_ATTEMPTS - 1 } })
  await DocumentService.recordOcrRejection(ARK_A, "duplicate folio", new Date(), at(synced, 1), ALIVE)
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.QUARANTINED)
  assert.match(row.reason ?? "", /^sync_rejected: duplicate folio/)
})

test("C recordOcrRejection: a pending row (asked, never answered) becomes unavailable with the reason; outage counters reset", async () => {
  await reset(ARK_A)
  const base = new Date(Date.now() - 10 * MINUTE)
  await DocumentService.recordOcrBatchOutage([ARK_A], base, ALIVE)
  await DocumentService.recordOcrRejection(ARK_A, "arks[0]: bad", new Date(), at(base, 1), ALIVE)
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.UNAVAILABLE)
  assert.equal(row.syncAttempts, 1)
  assert.equal(row.outageCount, 0, "a rejection is an answer: the worker was up")
})

test("B recordOcrSync: an incompatible artifact marks a never-synced ARK `incompatible` for 24 h, blaming nobody", async () => {
  await reset(ARK_A)
  const checkedAt = new Date()
  await DocumentService.recordOcrSync(plan({ checkedAt, incompatible: [{ ark: ARK_A, v: 2 }] }), ALIVE)
  const row = await rowOf(ARK_A)
  assert.equal(row.status, OCR_SYNC_STATUS.INCOMPATIBLE)
  assert.equal(row.reason, "artifact_version: worker artifact v2, this app reads v1")
  assert.equal(row.syncAttempts, 0)
  assert.equal(row.nextCheckAt?.getTime(), checkedAt.getTime() + OCR_SYNC_INCOMPATIBLE_RECHECK_MS)
})

test("FAIL 4 K1 worker-first rollout: an available row answered `building` stays available; a v2 artifact then makes it incompatible", async () => {
  const synced = new Date(Date.now() - 10 * MINUTE)
  await availableRow(ARK_A, synced)
  // The v2 worker reads its stored v1 artifact as corrupt and rebuilds it: `building`.
  await DocumentService.recordOcrSync(plan({ checkedAt: at(synced, 1), building: [ARK_A] }), ALIVE)
  let view = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(view?.status, OCR_SYNC_STATUS.AVAILABLE, "its stored quality is still shown")
  assert.equal(view?.folios.length, 1)
  // Rebuilt: a v2 artifact, which this (v1) app cannot read.
  await DocumentService.recordOcrSync(plan({ checkedAt: at(synced, 4), incompatible: [{ ark: ARK_A, v: 2 }] }), ALIVE)
  view = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(view?.status, OCR_SYNC_STATUS.INCOMPATIBLE, "shown as waiting for a service update")
  assert.equal((await rowOf(ARK_A)).expectedVersion, 1)
})

test("FAIL 4 reopenIncompatibleOcr: rows recorded against another app version are due at once, the current version's are not", async () => {
  await reset(ARK_A)
  await reset(ARK_B)
  const later = LATER()
  await prisma.documentOcr.createMany({
    data: [
      { ark: ARK_A, status: OCR_SYNC_STATUS.INCOMPATIBLE, checkedAt: new Date(0), nextCheckAt: later, expectedVersion: 0 },
      { ark: ARK_B, status: OCR_SYNC_STATUS.INCOMPATIBLE, checkedAt: new Date(0), nextCheckAt: later, expectedVersion: 1 },
    ],
  })
  const now = new Date()
  assert.ok((await DocumentService.reopenIncompatibleOcr(now)) >= 1)
  assert.equal((await rowOf(ARK_A)).nextCheckAt?.getTime(), now.getTime())
  assert.equal((await rowOf(ARK_B)).nextCheckAt?.getTime(), later.getTime())
})

test("FAIL 2/3 CAS: three drainers recording the SAME bracketed failure concurrently strike exactly once", async () => {
  await reset(ARK_A)
  const base = new Date(Date.now() - 10 * MINUTE)
  await DocumentService.recordOcrBatchOutage([ARK_A], base, ALIVE)
  const askedAt = at(base, 1)
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt, now: askedAt, bracketed: true }, ALIVE),
    ),
  )
  const struck = results.filter((r) => r.outcome === OCR_ALONE_OUTCOME.STRUCK).length
  assert.equal(struck, 1, JSON.stringify(results))
  assert.equal((await rowOf(ARK_A)).outageStrikes, 1)
})

test("FAIL 2/3 CAS: three drainers recording the SAME rejection concurrently count it once", async () => {
  await reset(ARK_A)
  const askedAt = new Date(Date.now() - MINUTE)
  await DocumentService.recordOcrBatchOutage([ARK_A], new Date(Date.now() - 2 * MINUTE), ALIVE)
  const results = await Promise.all(
    [0, 1, 2].map(() => DocumentService.recordOcrRejection(ARK_A, "duplicate folio", askedAt, askedAt, ALIVE)),
  )
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal((await rowOf(ARK_A)).syncAttempts, 1)
})

test("FAIL 2 quarantine heals: a quarantined ARK answered `available` is back to normal", async () => {
  await reset(ARK_A)
  await prisma.documentOcr.create({
    data: {
      ark: ARK_A,
      status: OCR_SYNC_STATUS.QUARANTINED,
      reason: "worker_fails_alone: 502",
      checkedAt: new Date(0),
      outageStrikes: OCR_SYNC_MAX_ATTEMPTS,
      outageCount: 9,
      nextCheckAt: new Date(0),
    },
  })
  await availableRow(ARK_A, new Date())
  const row = await rowOf(ARK_A)
  assert.deepEqual(
    [row.status, row.reason, row.outageStrikes, row.outageCount, row.nextCheckAt],
    [OCR_SYNC_STATUS.AVAILABLE, null, 0, 0, null],
  )
})

test("A recordOcrSync: any answer resets the outage count and strikes", async () => {
  await reset(ARK_A)
  await DocumentService.recordOcrBatchOutage([ARK_A], new Date(Date.now() - MINUTE), ALIVE)
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { outageStrikes: 3 } })
  await DocumentService.recordOcrSync(plan({ building: [ARK_A] }), ALIVE)
  const row = await rowOf(ARK_A)
  assert.deepEqual([row.outageCount, row.outageStrikes], [0, 0])
})

test("pendingOcrArks: a pending row keeps the never-asked rank and a stable order, with its outage count", async () => {
  await reset(ARK_A)
  await reset(ARK_B)
  const askedAt = new Date()
  await DocumentService.recordOcrBatchOutage([ARK_B], askedAt, ALIVE)
  await DocumentService.recordOcrBatchOutage([ARK_B], askedAt, ALIVE)
  const due = (await DocumentQueries.pendingOcrArks({ corpusProjectId: projectId, limit: ALL, now: new Date() }))
    .filter((d) => d.ark === ARK_A || d.ark === ARK_B)
  assert.deepEqual(due, [
    { ark: ARK_A, outageCount: 0 },
    { ark: ARK_B, outageCount: 2 },
  ], "ordered by ARK inside the never-answered rank, whatever their next_check_at")
})

test("D ocrPendingByCorpus: a `building` row's resync request does not hold the resync tier", async () => {
  await reset(ARK_A)
  await reset(ARK_B)
  await prisma.documentOcr.create({
    data: { ark: ARK_A, status: OCR_SYNC_STATUS.BUILDING, checkedAt: new Date(0), nextCheckAt: new Date(0), resyncRequestedAt: new Date(0) },
  })
  await prisma.documentOcr.create({
    data: { ark: ARK_B, status: OCR_SYNC_STATUS.AVAILABLE, checkedAt: new Date(0), nextCheckAt: null },
  })
  let mine = (await DocumentQueries.ocrPendingByCorpus(new Date())).find((r) => r.corpusProjectId === projectId)
  assert.equal(mine?.resync, 0)
  await DocumentService.ocrResyncOp([ARK_B], new Date())
  mine = (await DocumentQueries.ocrPendingByCorpus(new Date())).find((r) => r.corpusProjectId === projectId)
  assert.equal(mine?.resync, 1)
})

test("ocrControlArks: available ARKs without an outage on record, most recent first, never an excluded one", async () => {
  await availableRow(ARK_A, new Date(Date.now() + 365 * 24 * 60 * MINUTE)) // the most recent synced
  assert.equal((await DocumentQueries.ocrControlArks([], 3))[0], ARK_A)
  assert.ok(!(await DocumentQueries.ocrControlArks([ARK_A], 3)).includes(ARK_A))
  await prisma.documentOcr.update({ where: { ark: ARK_A }, data: { outageCount: 1 } })
  assert.ok(!(await DocumentQueries.ocrControlArks([], 50)).includes(ARK_A), "a control that failed is not a control")
})

test("syncBackoffMs schedule is what a failure alone writes", async () => {
  await reset(ARK_A)
  const askedAt = new Date()
  await DocumentService.recordOcrBatchOutage([ARK_A], askedAt, ALIVE)
  await DocumentService.recordOcrAloneFailure(ARK_A, "502", { askedAt, now: askedAt, bracketed: false }, ALIVE)
  const row = await rowOf(ARK_A)
  assert.equal(row.nextCheckAt?.getTime(), askedAt.getTime() + 2 * OCR_SYNC_BACKOFF_BASE_MS, "outage count 2 → 6 min")
})
