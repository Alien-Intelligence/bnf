// tests/models/documents/ocr-record.test.ts
// DocumentService.recordOcrSync + the DocumentQueries OCR reads against the
// dev Postgres (the lib/testing/fixtures.ts convention: the SQL is the thing
// under test, so it is not mocked). Feedback 2026-09-29 #7, Track B, Phase 4.
//
// What it guards:
//   - an available ARK's folios are REPLACED wholesale (a re-OCR drops folios
//     the new artifact no longer has) and a replay is idempotent;
//   - building / unavailable answers re-status the row and keep its folios;
//   - pendingOcrArks only ever returns INDEXED ARKs, skips available ones and
//     re-offers building / unavailable rows once their recheck window passed;
//   - isIndexedInCorpus is the D8 gate: indexed in THAT corpus, nothing else.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { prisma } from "@/lib/db"
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { DocumentQueries } from "@/models/documents/queries"
import { OCR_SOURCE, OCR_SYNC_STATUS } from "@/models/documents/schema"
import { DocumentService, type OcrSyncWritePlan } from "@/models/documents/service"

const tag = randomBytes(4).toString("hex")
const ARK_A = `ark:/12148/zzocr${tag}a`
const ARK_B = `ark:/12148/zzocr${tag}b`
const ARK_C = `ark:/12148/zzocr${tag}c` // in the corpus, never indexed
const TEST_ARKS = [ARK_A, ARK_B, ARK_C]
/** Large enough to cover every indexed ARK in the dev DB, so ordering does not hide ours. */
const ALL = 1_000_000

let userId: string
let projectId: string

function plan(over: Partial<OcrSyncWritePlan>): OcrSyncWritePlan {
  return { checkedAt: new Date(), available: [], building: [], unavailable: [], ...over }
}

function cutoffs(at: Date) {
  return { limit: ALL, buildingCutoff: at, unavailableCutoff: at }
}

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
  const pending = await DocumentQueries.pendingOcrArks(cutoffs(new Date()))
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
  const a = await DocumentQueries.ocrForArk(ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(a?.ocrRate, 0.7821)
  assert.equal(a?.folios.length, 2)
  const b = await DocumentQueries.ocrForArk(ARK_B)
  assert.equal(b?.status, OCR_SYNC_STATUS.BUILDING)
  assert.equal(b?.folios.length, 0)
})

test("ocrForRefs: only the asked (ark, folio) pairs that exist", async () => {
  const rows = await DocumentQueries.ocrForRefs([
    { ark: ARK_A, folio: 2 },
    { ark: ARK_A, folio: 3 },
    { ark: ARK_B, folio: 1 },
  ])
  assert.deepEqual(
    rows.map((r) => [r.ark, r.folio, r.ocrQuality]),
    [[ARK_A, 2, 0.661]],
  )
})

test("pendingOcrArks: available is done; building waits for its recheck window", async () => {
  const past = new Date(Date.now() - 60_000)
  const notYet = await DocumentQueries.pendingOcrArks(cutoffs(past))
  assert.ok(!notYet.includes(ARK_A), "available ARK is not pending")
  assert.ok(!notYet.includes(ARK_B), "building ARK checked just now is not due")

  const future = new Date(Date.now() + 60_000)
  const due = await DocumentQueries.pendingOcrArks(cutoffs(future))
  assert.ok(!due.includes(ARK_A), "available is never re-offered by the sweep")
  assert.ok(due.includes(ARK_B), "building ARK is re-offered once its window passed")
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
  const a = await DocumentQueries.ocrForArk(ARK_A)
  assert.deepEqual(
    a?.folios.map((f) => [f.folio, f.ocrQuality]),
    [[1, 0.95]],
  )
  assert.equal(a?.ocrRate, 0.8)
})

test("recordOcrSync: unavailable records the reason and keeps existing folios", async () => {
  await DocumentService.recordOcrSync(
    plan({ unavailable: [{ ark: ARK_A, reason: "no_pages_artifact" }] }),
  )
  const a = await DocumentQueries.ocrForArk(ARK_A)
  assert.equal(a?.status, OCR_SYNC_STATUS.UNAVAILABLE)
  assert.equal(a?.reason, "no_pages_artifact")
  assert.equal(a?.folios.length, 1)

  await DocumentService.recordOcrSync(plan({ building: [ARK_A] }))
  assert.equal((await DocumentQueries.ocrForArk(ARK_A))?.reason, null)
})

test("isIndexedInCorpus: indexed in this corpus only", async () => {
  assert.equal(await DocumentQueries.isIndexedInCorpus(projectId, ARK_A), true)
  assert.equal(await DocumentQueries.isIndexedInCorpus(projectId, ARK_C), false)
  assert.equal(await DocumentQueries.isIndexedInCorpus("no-such-project", ARK_A), false)
})
