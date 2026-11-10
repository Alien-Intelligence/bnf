// tests/models/ingest/large-commit-pg.test.ts
// The ingest terminal commit with thousands of per-ARK annotations, against
// real Postgres. Before the fix, commit() and commitPartialFailure() issued one
// UPDATE per failed/warning ARK inside one batch transaction under Prisma's
// default 5 s timeout, so a run with thousands of failures died with P2028 and
// the worker's terminal callback got an HTTP 500. The commit must now be a
// fixed number of statements, with the per-ARK state exactly as before:
// blanket indexError clear first, then failure reasons, then warning reasons.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/db"
import type { IngestJob, Project, User } from "@/lib/generated/prisma/client"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusQueries } from "@/models/corpus/queries"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"

const FAILED_COUNT = 20_000
const WARNING_COUNT = 1_000
const SUCCEEDED_COUNT = 1_000
const STALE_ERROR = "stale error from a previous run"
// Awkward characters a reason can carry; they must round-trip verbatim.
const awkward = (i: number) => `échec n°${i} — "cité" 'x' \\ {a,b} NUL-free`

const tag = randomBytes(4).toString("hex")
const arkOf = (kind: string, i: number) => `ark:/12148/${kind}${tag}${String(i).padStart(6, "0")}`

let user: User
const projects: string[] = []

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) {
    await prisma.$executeRaw`DELETE FROM document WHERE project_id = ${id}`
    await cleanupProject(id)
  }
  await deleteTestUser(user.id)
})

type Fixture = {
  project: Project
  job: IngestJob
  failed: string[]
  warned: string[]
  succeeded: string[]
}

/** A project whose running job added every fixture ARK, each carrying a stale error. */
async function fixture(label: string): Promise<Fixture> {
  const project = await createTestProject(user.id, `large-commit ${label}`)
  projects.push(project.id)
  const failed = Array.from({ length: FAILED_COUNT }, (_, i) => arkOf("bpt6kf", i))
  const warned = Array.from({ length: WARNING_COUNT }, (_, i) => arkOf("bpt6kw", i))
  const succeeded = Array.from({ length: SUCCEEDED_COUNT }, (_, i) => arkOf("bpt6ks", i))
  const addedArks = [...failed, ...warned, ...succeeded]
  await prisma.document.createMany({
    data: addedArks.map((ark) => ({
      projectId: project.id,
      ark,
      source: "gallica",
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
      indexError: STALE_ERROR,
    })),
  })
  const head = await CorpusQueries.headVersion(project.id)
  const job = await IngestQueries.create({
    projectId: project.id,
    targetVersionId: head.id,
    status: INGEST_STATUS.RUNNING,
    addedCount: addedArks.length,
    removedCount: 0,
    addedArks,
    removedArks: [],
    callbackSecret: "s",
  })
  return { project, job, failed, warned, succeeded }
}

async function stateOf(projectId: string, arks: string[]) {
  const rows = await prisma.document.findMany({
    where: { projectId, ark: { in: arks } },
    select: { ark: true, indexedAt: true, indexError: true },
  })
  return new Map(rows.map((r) => [r.ark, r]))
}

test("commitPartialFailure with thousands of failures and warnings commits and keeps per-ARK state", async () => {
  const { project, job, failed, warned, succeeded } = await fixture("partial")
  const errors = [
    ...failed.map((ark, i) => ({ ark, stage: "extract", reason: awkward(i) })),
    ...warned.map((ark, i) => ({ ark, stage: "extract", reason: `pages perdues ${i}`, warning: true })),
  ]

  const started = Date.now()
  await IngestService.commitPartialFailure(job, {
    chunksWritten: 7,
    stats: { total: job.addedArks.length, failed: failed.length, errors },
  })
  console.log(`commitPartialFailure (${failed.length} failures, ${warned.length} warnings): ${Date.now() - started} ms`)

  const committed = await IngestQueries.getOrThrow(job.id)
  assert.equal(committed.status, INGEST_STATUS.PARTIAL)
  const version = await prisma.corpusVersion.findUniqueOrThrow({ where: { id: job.targetVersionId } })
  assert.equal(version.status, CORPUS_VERSION_STATUS.INGESTED)
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).ingestedVersionId, job.targetVersionId)

  const failedState = await stateOf(project.id, failed)
  for (const [i, ark] of failed.entries()) {
    const row = failedState.get(ark)
    assert.equal(row?.indexedAt, null, `${ark} stays in the delta`)
    assert.equal(row?.indexError, awkward(i), `${ark} carries its reason verbatim`)
  }
  const warnedState = await stateOf(project.id, warned)
  for (const [i, ark] of warned.entries()) {
    const row = warnedState.get(ark)
    assert.notEqual(row?.indexedAt, null, `${ark} is indexed`)
    assert.equal(row?.indexError, `pages perdues ${i}`, `${ark} keeps its warning after the blanket clear`)
  }
  const succeededState = await stateOf(project.id, succeeded)
  for (const ark of succeeded) {
    const row = succeededState.get(ark)
    assert.notEqual(row?.indexedAt, null, `${ark} is indexed`)
    assert.equal(row?.indexError, null, `${ark} lost its stale error`)
  }
})

test("commit with thousands of warning-only entries commits and keeps every warning", async () => {
  const { project, job, failed, warned, succeeded } = await fixture("warnings")
  const everyone = [...failed, ...warned, ...succeeded]
  const errors = everyone.map((ark, i) => ({ ark, stage: "extract", reason: `pages perdues ${i}`, warning: true }))

  const started = Date.now()
  await IngestService.commit(job, { chunksWritten: 7, stats: { total: everyone.length, errors } })
  console.log(`commit (${errors.length} warnings): ${Date.now() - started} ms`)

  assert.equal((await IngestQueries.getOrThrow(job.id)).status, INGEST_STATUS.DONE)
  const state = await stateOf(project.id, everyone)
  for (const [i, ark] of everyone.entries()) {
    const row = state.get(ark)
    assert.notEqual(row?.indexedAt, null, `${ark} is indexed`)
    assert.equal(row?.indexError, `pages perdues ${i}`)
  }
})
