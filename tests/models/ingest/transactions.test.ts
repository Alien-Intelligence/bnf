// models/ingest/service.ts transaction boundaries, DB-backed. The service no
// longer touches Prisma itself (playbook/models.md): these tests pin that every
// state change it delegates to IngestQueries still lands atomically and with
// the same outcome as before the move.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { IngestJob, Project, User } from "@/lib/generated/prisma/client"
import { CorpusService } from "@/models/corpus/service"
import { CorpusQueries } from "@/models/corpus/queries"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
let project: Project

const INDEXED = "ark:/12148/bpt6k9600001"
const ADDED = "ark:/12148/bpt6k9600002"
const REMOVED = "ark:/12148/bpt6k9600003"

const fresh = () => prisma.project.findUniqueOrThrow({ where: { id: project.id } })

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "ingest-transactions")
  const base = { projectId: project.id, resolveStatus: "resolved", source: "gallica", docType: "press" }
  await prisma.document.createMany({
    data: [
      { ...base, ark: INDEXED, indexedAt: new Date() },
      { ...base, ark: ADDED },
      { ...base, ark: REMOVED, indexedAt: new Date() },
    ],
  })
  await CorpusService.addArks(project, user, { arks: [INDEXED], reason: "fixture" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("submit with an empty delta creates a done no-op job and advances the pointer atomically", async () => {
  // REMOVED is indexed yet not in the head, so it must go first to empty the delta.
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: REMOVED } },
    data: { indexedAt: null },
  })
  const outcome = await IngestService.submit(await fresh(), user, {})
  assert.equal(outcome.kind, "job")
  if (outcome.kind !== "job") return
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(outcome.job.status, INGEST_STATUS.DONE)
  assert.deepEqual(outcome.job.stats, { noOp: true })
  assert.equal(outcome.job.targetVersionId, head.id)
  assert.equal((await fresh()).ingestedVersionId, head.id)
  const version = await prisma.corpusVersion.findUniqueOrThrow({ where: { id: head.id } })
  assert.equal(version.status, CORPUS_VERSION_STATUS.INGESTED)
})

async function queuedJob(addedArks: string[], removedArks: string[]): Promise<IngestJob> {
  const head = await CorpusQueries.headVersion(project.id)
  return IngestQueries.create({
    projectId: project.id,
    targetVersionId: head.id,
    status: INGEST_STATUS.RUNNING,
    addedCount: addedArks.length,
    removedCount: removedArks.length,
    addedArks,
    removedArks,
    callbackSecret: "s",
  })
}

test("commit marks the job done, the version ingested, the pointer, and the per-document index state in one go", async () => {
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: REMOVED } },
    data: { indexedAt: new Date() },
  })
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: ADDED } },
    data: { indexError: "stale" },
  })
  const job = await queuedJob([ADDED], [REMOVED])
  await IngestService.commit(job, { chunksWritten: 7, stats: { total: 1, failed: 0 } })

  const done = await IngestQueries.getOrThrow(job.id)
  assert.equal(done.status, INGEST_STATUS.DONE)
  assert.equal(done.chunksWritten, 7)
  assert.equal((await fresh()).ingestedVersionId, job.targetVersionId)
  const docs = await prisma.document.findMany({ where: { projectId: project.id } })
  const byArk = new Map(docs.map((d) => [d.ark, d]))
  assert.notEqual(byArk.get(ADDED)?.indexedAt, null)
  assert.equal(byArk.get(ADDED)?.indexError, null)
  assert.equal(byArk.get(REMOVED)?.indexedAt, null)
})

test("commitPartialFailure records the failed document's reason and leaves it un-indexed", async () => {
  const job = await queuedJob([ADDED], [])
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: ADDED } },
    data: { indexedAt: null },
  })
  await IngestService.commitPartialFailure(job, {
    chunksWritten: 0,
    stats: { total: 1, failed: 1, errors: [{ ark: ADDED, stage: "embed", reason: "boom" }] },
  })

  const partial = await IngestQueries.getOrThrow(job.id)
  assert.equal(partial.status, INGEST_STATUS.PARTIAL)
  const doc = await prisma.document.findUniqueOrThrow({
    where: { projectId_ark: { projectId: project.id, ark: ADDED } },
  })
  assert.equal(doc.indexedAt, null)
  assert.equal(doc.indexError, "boom")
})

test("failStuckJob and mirrorWatchdogProgress never overwrite a job that left the expected status", async () => {
  const job = await queuedJob([], [])
  await IngestService.mirrorWatchdogProgress(job.id, 0.5, { done: 1 })
  assert.equal(Number((await IngestQueries.getOrThrow(job.id)).progress), 0.5)

  await IngestService.failStuckJob(job.id, INGEST_STATUS.QUEUED, "wrong expectation", new Date())
  assert.equal((await IngestQueries.getOrThrow(job.id)).status, INGEST_STATUS.RUNNING)

  await IngestService.failStuckJob(job.id, INGEST_STATUS.RUNNING, "stuck", new Date())
  const failed = await IngestQueries.getOrThrow(job.id)
  assert.equal(failed.status, INGEST_STATUS.FAILED)
  assert.equal(failed.error, "stuck")

  await IngestService.mirrorWatchdogProgress(job.id, 0.9, { done: 2 })
  assert.equal(Number((await IngestQueries.getOrThrow(job.id)).progress), 0.5)
})
