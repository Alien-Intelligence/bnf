// lib/agent/tools/ocr-gate.test.ts
// The D8 gate at the agent-tool level (feedback 2026-09-29 #7, Track B): the
// OCR-quality tables are global per ARK, so a tool must only ever answer for
// Documents of the corpus the turn reads — the SOURCE's, in a derived
// workspace — and refuse everything else, even an ARK whose quality is stored.
// Exercised through the real handlers on a derived-workspace ctx, against the
// dev Postgres (the lib/testing/fixtures.ts convention).
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { OCR_SOURCE, OCR_STATUS_PENDING, OCR_SYNC_STATUS } from "@/models/documents/schema"

import { ARK_NOT_IN_CORPUS_ERROR } from "./constants"
import { docGetTool } from "./doc"
import { CORPUS_ACCESS_REVOKED_ERROR } from "./ingestion-guard"
import { ragGetTextTool } from "./rag"
import type { TurnScopedCtx } from "./registry-factory"

const tag = randomBytes(4).toString("hex")
const ARK_SOURCE = `ark:/12148/zzgate${tag}s` // a Document of the source corpus
const ARK_WORKSPACE = `ark:/12148/zzgate${tag}w` // a Document of the workspace only
const ARK_BUILDING = `ark:/12148/zzgate${tag}b`
const ARK_QUARANTINED = `ark:/12148/zzgate${tag}q`
const ARKS = [ARK_SOURCE, ARK_WORKSPACE, ARK_BUILDING, ARK_QUARANTINED]

let user: User
let userId: string
let sourceId: string
let workspaceId: string

function derivedCtx(over: Partial<TurnScopedCtx> = {}): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user,
    appSessionId: "test-session",
    projectId: workspaceId,
    corpusProjectId: sourceId,
    corpusReachable: true,
    scope: "research",
    ...over,
  }
}

before(async () => {
  user = await createTestUser()
  userId = user.id
  sourceId = (await createTestProject(userId, "ocr-gate-source")).id
  workspaceId = (await createTestProject(userId, "ocr-gate-workspace")).id
  await markHeadIngested(sourceId)
  const indexedAt = new Date()
  await prisma.document.createMany({
    data: [
      { projectId: sourceId, ark: ARK_SOURCE, indexedAt },
      { projectId: sourceId, ark: ARK_BUILDING, indexedAt },
      { projectId: sourceId, ark: ARK_QUARANTINED, indexedAt },
      { projectId: workspaceId, ark: ARK_WORKSPACE, indexedAt },
    ],
  })
  const now = new Date()
  await prisma.documentOcr.create({
    data: {
      ark: ARK_SOURCE,
      status: OCR_SYNC_STATUS.AVAILABLE,
      ocrRate: 0.7821,
      checkedAt: now,
      syncedAt: now,
      folios: { create: [{ folio: 2, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.661, wordCount: 4016 }] },
    },
  })
  await prisma.documentOcr.create({
    data: {
      ark: ARK_WORKSPACE,
      status: OCR_SYNC_STATUS.AVAILABLE,
      ocrRate: 0.1,
      checkedAt: now,
      syncedAt: now,
      folios: { create: [{ folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.1, wordCount: 10 }] },
    },
  })
  await prisma.documentOcr.create({
    data: { ark: ARK_BUILDING, status: OCR_SYNC_STATUS.BUILDING, checkedAt: now },
  })
  await prisma.documentOcr.create({
    data: {
      ark: ARK_QUARANTINED,
      status: OCR_SYNC_STATUS.QUARANTINED,
      reason: "sync_rejected: test",
      checkedAt: now,
    },
  })
})

after(async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: { in: ARKS } } })
  await cleanupProject(workspaceId)
  await cleanupProject(sourceId)
  await deleteTestUser(userId)
})

test("doc_get on a derived ctx answers for the SOURCE corpus document", async () => {
  const result = (await docGetTool.handler({ ark: ARK_SOURCE }, derivedCtx())) as Record<string, unknown>
  assert.deepEqual(result["ocr"], {
    status: OCR_SYNC_STATUS.AVAILABLE,
    ocrRate: 0.7821,
    scoredFolios: 1,
    lowFolios: [2],
    lowFolioCount: 1,
  })
})

test("doc_get refuses the workspace's own document, even with stored quality", async () => {
  const result = (await docGetTool.handler({ ark: ARK_WORKSPACE }, derivedCtx())) as Record<string, unknown>
  assert.equal(result["error"], ARK_NOT_IN_CORPUS_ERROR)
  assert.equal(result["ocr"], undefined)
})

test("doc_get through a revoked grant answers the revocation", async () => {
  const result = (await docGetTool.handler(
    { ark: ARK_SOURCE },
    derivedCtx({ corpusReachable: false }),
  )) as Record<string, unknown>
  assert.equal(result["error"], CORPUS_ACCESS_REVOKED_ERROR)
})

test("doc_get summary keeps building / quarantined / pending distinct from 'nothing low'", async () => {
  for (const [ark, status] of [
    [ARK_BUILDING, OCR_SYNC_STATUS.BUILDING],
    [ARK_QUARANTINED, OCR_SYNC_STATUS.QUARANTINED],
  ] as const) {
    const result = (await docGetTool.handler({ ark }, derivedCtx())) as { ocr: { status: string } }
    assert.equal(result.ocr.status, status)
  }
  await prisma.documentOcr.deleteMany({ where: { ark: ARK_BUILDING } })
  const pending = (await docGetTool.handler({ ark: ARK_BUILDING }, derivedCtx())) as {
    ocr: { status: string }
  }
  assert.equal(pending.ocr.status, OCR_STATUS_PENDING)
})

test("rag_get_text on a derived ctx refuses an ARK outside the source corpus", async () => {
  const result = (await ragGetTextTool.handler(
    { entryId: 1, ark: ARK_WORKSPACE },
    derivedCtx(),
  )) as Record<string, unknown>
  assert.deepEqual(result, { text: "", error: ARK_NOT_IN_CORPUS_ERROR, ark: ARK_WORKSPACE })
})
