// models/buffer/service.test.ts
// BufferService is the heart of the "tampon": it stages search hits, curates
// them, and is the ONE place the buffer touches the versioned corpus (commit →
// CorpusService.addArks → advanceVersion). These tests assert the durable
// invariants the plan §5 calls out, against the real dev Postgres (deterministic,
// no LLM/MCP). Each test owns a fresh project so ordering never matters.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { BufferService } from "./service"
import { BufferQueries } from "./queries"
import { BUFFER_STATUS } from "./schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const projects: string[] = []

/** A fresh project registered for teardown. */
async function freshProject(label: string): Promise<Project> {
  const p = await createTestProject(user.id, label)
  projects.push(p.id)
  return p
}

const ARK = (n: number) => `ark:/12148/bpt6k${String(n).padStart(6, "0")}`

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) await cleanupProject(id)
  await deleteTestUser(user.id)
})

// --- registerCandidates: dedupe, skip invalid, refresh vs added -------------

test("registerCandidates dedupes by ARK within a batch (last write wins)", async () => {
  const project = await freshProject("dedupe")
  const result = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [
      { ark: ARK(1), title: "Premier titre" },
      { ark: ARK(2), title: "Autre" },
      { ark: ARK(1), title: "Titre corrigé" }, // same ARK — collapses to one row
    ],
  })
  assert.equal(result.requested, 3)
  assert.equal(result.added, 2, "two unique ARKs inserted")
  assert.equal(result.total, 2)

  const rows = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: ARK(1) } })
  assert.equal(rows.length, 1, "no duplicate row for the repeated ARK")
  assert.equal(rows[0].title, "Titre corrigé", "last write wins on metadata")
})

test("registerCandidates skips identifiers that are not valid ARKs", async () => {
  const project = await freshProject("skip-invalid")
  const result = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [
      { ark: ARK(10) },
      { ark: "cb32895690b/date" }, // periodical COLLECTION form — must never stage
      { ark: "not-an-ark" },
    ],
  })
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 2, "both malformed identifiers rejected")
  const staged = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(staged, [ARK(10)])
})

test("re-registering an existing ARK refreshes metadata, not the row count", async () => {
  const project = await freshProject("refresh")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(20), title: "Titre initial" }],
  })
  const second = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(20), title: "Titre enrichi", year: 1889 }],
  })
  assert.equal(second.added, 0, "no new row")
  assert.equal(second.refreshed, 1, "existing row refreshed")
  assert.equal(second.total, 1)
  const row = await prisma.bufferItem.findFirstOrThrow({ where: { projectId: project.id, ark: ARK(20) } })
  assert.equal(row.title, "Titre enrichi")
  assert.equal(row.year, 1889)
})

// --- removeByFilter: empty refusal, dry-run purity, real removal ------------

test("removeByFilter refuses an empty filter without mutating", async () => {
  const project = await freshProject("empty-filter")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(30), year: 1889 }],
  })
  const result = await BufferService.removeByFilter(project.id, { filters: {}, dryRun: false })
  assert.equal(result.status, "empty_filter")
  assert.equal(await BufferQueries.count(project.id), 1, "buffer untouched")
})

test("removeByFilter dry-run previews the match set WITHOUT removing", async () => {
  const project = await freshProject("dry-run")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [
      { ark: ARK(40), year: 1889 },
      { ark: ARK(41), year: 1889 },
      { ark: ARK(42), year: 1920 },
    ],
  })
  const preview = await BufferService.removeByFilter(project.id, {
    filters: { yearFrom: 1889, yearTo: 1889 },
    dryRun: true,
  })
  assert.equal(preview.status, "dry_run")
  if (preview.status === "dry_run") assert.equal(preview.matched, 2)
  assert.equal(await BufferQueries.count(project.id), 3, "dry-run mutated nothing")
})

test("removeByFilter (dryRun=false) discards the matching candidates", async () => {
  const project = await freshProject("remove")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [
      { ark: ARK(50), year: 1889 },
      { ark: ARK(51), year: 1920 },
    ],
  })
  const result = await BufferService.removeByFilter(project.id, {
    filters: { yearFrom: 1920, yearTo: 1920 },
    dryRun: false,
  })
  assert.equal(result.status, "removed")
  if (result.status === "removed") assert.equal(result.removed, 1)
  const remaining = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(remaining, [ARK(50)], "only the non-matching candidate remains")
})

// --- commit: advances the corpus version exactly once -----------------------

test("commit moves candidates into the corpus, advancing the version exactly once", async () => {
  const project = await freshProject("commit")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(60), title: "A" }, { ark: ARK(61), title: "B" }],
  })

  const versionsBefore = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  const headBefore = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { headVersionId: true },
  })

  const result = await BufferService.commit(project, user, { reason: "unit commit" })
  assert.equal(result.committed, 2)

  const versionsAfter = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  assert.equal(versionsAfter, versionsBefore + 1, "exactly one new version created")

  const projectAfter = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { headVersionId: true },
  })
  assert.notEqual(projectAfter.headVersionId, headBefore.headVersionId, "head pointer advanced")

  const members = await prisma.corpusMembership.count({
    where: { versionId: projectAfter.headVersionId ?? "" },
  })
  assert.equal(members, 2, "both ARKs are members of the new head version")

  const candidatesLeft = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const committedRows = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  assert.equal(candidatesLeft, 0, "committed candidates left the active buffer")
  assert.equal(committedRows, 2, "rows kept as committed provenance")
})

test("commit with an empty buffer does NOT advance a version", async () => {
  const project = await freshProject("commit-empty")
  const versionsBefore = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  const result = await BufferService.commit(project, user, { reason: "nothing staged" })
  assert.equal(result.committed, 0)
  const versionsAfter = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  assert.equal(versionsAfter, versionsBefore, "no version created for an empty commit")
})

test("a committed ARK is not resurrected as a candidate by a later search", async () => {
  const project = await freshProject("no-resurrect")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(70) }],
  })
  await BufferService.commit(project, user, { reason: "commit then re-search" })

  const again = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(70), title: "Re-trouvé" }],
  })
  assert.equal(again.added, 0, "no new candidate row")
  const candidates = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(candidates, [], "the committed ARK stays out of the candidate set")
})

// --- clear / discard --------------------------------------------------------

test("clear drops candidate + discarded rows but preserves committed provenance", async () => {
  const project = await freshProject("clear")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(80) }, { ark: ARK(81) }, { ark: ARK(82) }],
  })
  await BufferService.discard(project.id, [ARK(81)]) // → discarded
  await BufferService.commit(project, user, { reason: "commit the rest" }) // ARK(80),ARK(82) → committed

  // Stage one fresh candidate, then clear.
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(83) }],
  })
  const removed = await BufferService.clear(project.id)
  assert.ok(removed >= 1, "clear removed the leftover candidate/discarded rows")

  const committed = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  const others = await prisma.bufferItem.count({
    where: { projectId: project.id, status: { in: [BUFFER_STATUS.CANDIDATE, BUFFER_STATUS.DISCARDED] } },
  })
  assert.equal(committed, 2, "committed provenance survives clear")
  assert.equal(others, 0, "no candidate/discarded rows remain")
})

test("discard marks candidates discarded (only from the candidate set)", async () => {
  const project = await freshProject("discard")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    candidates: [{ ark: ARK(90) }, { ark: ARK(91) }],
  })
  const n = await BufferService.discard(project.id, [ARK(90)])
  assert.equal(n, 1)
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [ARK(91)])
  // Discarding again is a no-op (already left the candidate set).
  assert.equal(await BufferService.discard(project.id, [ARK(90)]), 0)
})
