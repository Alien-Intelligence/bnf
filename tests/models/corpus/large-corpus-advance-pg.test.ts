// tests/models/corpus/large-corpus-advance-pg.test.ts
// A version advance on a LARGE corpus, against real Postgres. Before the fix,
// advanceVersion copied the parent's whole membership through Node inside one
// interactive transaction under Prisma's default 5 s timeout, so on a corpus of
// tens of thousands of documents every mutation died with P2028. The corpus is
// seeded past that point (head >= LARGE_CORPUS_SIZE members) and each mutation
// path (add, remove, swap) must advance it, alone and racing another mutation.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusQueries } from "@/models/corpus/queries"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_CANONICAL_STATUS, DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

// Past the point where copying the membership through Node outran Prisma's
// default 5 s interactive-transaction timeout on the test database.
const LARGE_CORPUS_SIZE = 120_000
const tag = randomBytes(4).toString("hex")
const arkOf = (kind: string, i: number) => `ark:/12148/${kind}${tag}${String(i).padStart(6, "0")}`

let user: User
let project: Project

/**
 * Seeds `LARGE_CORPUS_SIZE` resolved documents plus the three notices the swap
 * tests use, and makes them the head's membership. Raw set-based SQL: seeding
 * through the code under test would hit the very timeout being reproduced.
 */
async function seedLargeHead(): Promise<void> {
  const head = await CorpusQueries.headVersion(project.id)
  await prisma.$executeRaw`
    INSERT INTO document (project_id, ark, resolve_status, source, title)
    SELECT ${project.id}, 'ark:/12148/bpt6k' || ${tag} || lpad(g::text, 6, '0'),
           ${DOCUMENT_RESOLVE_STATUS.RESOLVED}, 'gallica', 'seed'
    FROM generate_series(1, ${LARGE_CORPUS_SIZE}) AS g`
  const next = await prisma.corpusVersion.create({
    data: {
      projectId: project.id,
      seq: head.seq + 1,
      status: CORPUS_VERSION_STATUS.SEALED,
      parentId: head.id,
      createdBy: `user:${user.id}`,
      note: "large fixture",
    },
  })
  await prisma.$executeRaw`
    INSERT INTO corpus_membership (version_id, ark, project_id)
    SELECT ${next.id}, ark, project_id FROM document WHERE project_id = ${project.id}`
  await prisma.project.update({ where: { id: project.id }, data: { headVersionId: next.id } })
}

async function addDocuments(arks: string[], source: string, canonicalStatus: string | null): Promise<void> {
  await prisma.document.createMany({
    data: arks.map((ark) => ({
      projectId: project.id,
      ark,
      source,
      title: ark,
      canonicalStatus,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
}

async function memberCount(versionId: string): Promise<number> {
  return prisma.corpusMembership.count({ where: { versionId } })
}

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "large-corpus-advance")
  await seedLargeHead()
})

after(async () => {
  // The shared teardown deletes the corpus in one bounded batch; at this size
  // that exceeds it, so the bulk rows go first, set-based.
  await prisma.$executeRaw`DELETE FROM corpus_membership WHERE project_id = ${project.id}`
  await prisma.$executeRaw`DELETE FROM document WHERE project_id = ${project.id}`
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("seed: the head holds the large corpus", async () => {
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(await memberCount(head.id), LARGE_CORPUS_SIZE)
})

test("addArks advances a large head by one ARK and carries every member", async () => {
  const before = await CorpusQueries.headVersion(project.id)
  const added = arkOf("bpt6kadd", 1)
  await addDocuments([added], "gallica", null)

  const started = Date.now()
  const result = await CorpusService.addArks(project, user, { arks: [added], reason: "large add" })
  console.log(`large addArks (${LARGE_CORPUS_SIZE} members): ${Date.now() - started} ms`)

  assert.equal(result.total, LARGE_CORPUS_SIZE + 1)
  assert.equal(result.versionSeq, before.seq + 1)
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(head.parentId, before.id)
  assert.equal(await memberCount(head.id), LARGE_CORPUS_SIZE + 1)
  assert.ok(head.membership.some((m) => m.ark === added))
  assert.equal(await memberCount(before.id), LARGE_CORPUS_SIZE, "the parent version is immutable")
})

test("removeArks advances a large head and drops only the removed ARK", async () => {
  const before = await CorpusQueries.headVersion(project.id)
  const removed = arkOf("bpt6k", 1)
  assert.ok(before.membership.some((m) => m.ark === removed), "the removed ARK is a seeded member")

  const result = await CorpusService.removeArks(project, user, { arks: [removed], reason: "large remove" })

  assert.equal(result.lastDeltaRemoved, 1)
  assert.equal(result.total, before.membership.length - 1)
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(head.seq, before.seq + 1)
  assert.equal(head.membership.length, before.membership.length - 1)
  assert.ok(!head.membership.some((m) => m.ark === removed))
})

test("swapCanonicalNotices advances a large head in one version", async () => {
  const notice = arkOf("cb", 1)
  const canonical = arkOf("bpt6kcanon", 1)
  await addDocuments([notice], "catalogue", DOCUMENT_CANONICAL_STATUS.PENDING)
  await addDocuments([canonical], "gallica", null)
  await CorpusService.addArks(project, user, { arks: [notice], reason: "notice" })
  const before = await CorpusQueries.headVersion(project.id)

  const swapped = await CorpusService.swapCanonicalNotices(project.id, new Map([[notice, canonical]]))

  assert.equal(swapped, 1)
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(head.seq, before.seq + 1)
  assert.equal(head.membership.length, before.membership.length, "a swap is size-neutral")
  const arks = new Set(head.membership.map((m) => m.ark))
  assert.ok(arks.has(canonical))
  assert.ok(!arks.has(notice))
})

test("an add racing a canonical swap: both succeed, seqs stay monotonic, no member is lost", async () => {
  const notice = arkOf("cb", 2)
  const canonical = arkOf("bpt6kcanon", 2)
  const racer = arkOf("bpt6krace", 1)
  await addDocuments([notice], "catalogue", DOCUMENT_CANONICAL_STATUS.PENDING)
  await addDocuments([canonical, racer], "gallica", null)
  await CorpusService.addArks(project, user, { arks: [notice], reason: "notice" })
  const before = await CorpusQueries.headVersion(project.id)
  const sizeBefore = before.membership.length

  const [added, swapped] = await Promise.all([
    CorpusService.addArks(project, user, { arks: [racer], reason: "racing add" }),
    CorpusService.swapCanonicalNotices(project.id, new Map([[notice, canonical]])),
  ])

  assert.equal(swapped, 1)
  assert.ok(added.versionSeq === before.seq + 1 || added.versionSeq === before.seq + 2)
  const versions = await prisma.corpusVersion.findMany({
    where: { projectId: project.id, seq: { gt: before.seq } },
    orderBy: { seq: "asc" },
  })
  assert.deepEqual(
    versions.map((v) => v.seq),
    [before.seq + 1, before.seq + 2],
    "two consecutive seqs, none skipped or duplicated",
  )
  assert.equal(versions[1].parentId, versions[0].id, "the second advance builds on the first")
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(head.id, versions[1].id)
  const arks = new Set(head.membership.map((m) => m.ark))
  assert.equal(arks.size, sizeBefore + 1, "the add grew it by one; the swap is size-neutral")
  assert.ok(arks.has(racer))
  assert.ok(arks.has(canonical))
  assert.ok(!arks.has(notice))
})
