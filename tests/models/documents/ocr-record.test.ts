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
//   - a contract-breaking ARK backs off and is quarantined after
//     OCR_SYNC_MAX_ATTEMPTS, after which the sweep no longer offers it;
//   - every user-facing read is gated on the reader's corpus: an ARK outside
//     it reads as nothing, even with stored rows (plan D8).
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { OCR_SYNC_MAX_ATTEMPTS } from "@/lib/constants"
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
import { DocumentService } from "@/models/documents/service"

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
  return { checkedAt: new Date(), available: [], building: [], unavailable: [], ...over }
}

function pendingAt(now: Date) {
  return DocumentQueries.pendingOcrArks({ limit: ALL, now })
}

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
    }),
  )
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
    }),
  )
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
    }),
  )
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
  await DocumentService.recordOcrSync(reocr)
  await DocumentService.recordOcrSync(reocr)
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.deepEqual(
    a?.folios.map((f) => [f.folio, f.ocrQuality]),
    [[1, 0.95]],
  )
})

test("recordOcrSync: unavailable records the reason and keeps existing folios", async () => {
  await DocumentService.recordOcrSync(
    plan({ unavailable: [{ ark: ARK_A, reason: "no_pages_artifact" }] }),
  )
  const a = await DocumentQueries.ocrForArk(projectId, ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.UNAVAILABLE)
  assert.equal(a?.reason, "no_pages_artifact")
  assert.equal(a?.folios.length, 1)
})

test("recordOcrRejection: backs off, then quarantines after OCR_SYNC_MAX_ATTEMPTS", async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_B } })
  for (let i = 1; i < OCR_SYNC_MAX_ATTEMPTS; i += 1) {
    await DocumentService.recordOcrRejection(ARK_B, "worker refused", new Date())
    const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
    assert.equal(row.syncAttempts, i)
    assert.equal(row.status, OCR_SYNC_STATUS.UNAVAILABLE)
    assert.ok(row.nextCheckAt !== null && row.nextCheckAt > new Date(), "backs off into the future")
    assert.ok(!(await pendingAt(new Date())).includes(ARK_B), "not offered while backing off")
  }
  await DocumentService.recordOcrRejection(ARK_B, "worker refused", new Date())
  const row = await prisma.documentOcr.findUniqueOrThrow({ where: { ark: ARK_B } })
  assert.equal(row.status, OCR_SYNC_STATUS.QUARANTINED)
  assert.equal(row.nextCheckAt, null)
  assert.ok(row.reason !== null && /^sync_rejected: worker refused/.test(row.reason))
  assert.ok(!(await pendingAt(LATER())).includes(ARK_B), "a quarantined ARK is never offered again")

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
    }),
  )
  await DocumentService.recordOcrRejection(ARK_A, "bad answer", new Date())
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
