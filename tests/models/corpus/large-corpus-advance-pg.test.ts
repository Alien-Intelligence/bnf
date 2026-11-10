// tests/models/corpus/large-corpus-advance-pg.test.ts
// A version advance on a LARGE corpus, against real Postgres. Before the fix,
// advanceVersion copied the parent's whole membership through Node inside one
// interactive transaction under Prisma's default 5 s timeout, so on a corpus of
// tens of thousands of documents every mutation died with P2028. The corpus is
// seeded past that point, through seedCorpusDocuments (advanceVersion, the path
// a real add takes) and torn down by cleanupProject, and each mutation
// path (add, remove, swap) must advance it, alone and racing another mutation.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { CorpusQueries } from "@/models/corpus/queries"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_CANONICAL_STATUS, DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

// Past the point where copying the membership through Node outran Prisma's
// default 5 s interactive-transaction timeout on the test database.
const LARGE_CORPUS_SIZE = 120_000
// Enough foreign stubs that a scan of the version per stub cannot finish in time.
const FOREIGN_PENDING_STUBS = 3_000
const tag = randomBytes(4).toString("hex")
const arkOf = (kind: string, i: number) => `ark:/12148/${kind}${tag}${String(i).padStart(6, "0")}`

let user: User
let project: Project
let stubsProject: Project

/** Seeds the large head through the same path a real add takes: advanceVersion. */
async function seedLargeHead(): Promise<void> {
  const docs = Array.from({ length: LARGE_CORPUS_SIZE }, (_, i) => ({
    ark: arkOf("bpt6k", i + 1),
    source: "gallica",
    title: "seed",
    resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
  }))
  await seedCorpusDocuments(project.id, docs, `user:${user.id}`)
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
  // A freshly bulk-loaded table has no planner statistics until autovacuum gets
  // to it; under load the snapshot counts then plan as if it were empty.
  await prisma.$executeRaw`ANALYZE document`
  await prisma.$executeRaw`ANALYZE corpus_membership`
  // Other projects' pending stubs, born after the statistics above: the corpus
  // counts of THIS project must not scale with them (they did, one scan of the
  // whole version per stub, once a new version has no statistics yet).
  stubsProject = await createTestProject(user.id, "large-corpus-advance stubs")
  await prisma.$executeRaw`
    INSERT INTO document (project_id, ark, resolve_status, source)
    SELECT ${stubsProject.id}, 'ark:/12148/bpt6kstub' || ${tag} || lpad(g::text, 6, '0'),
           ${DOCUMENT_RESOLVE_STATUS.PENDING}, 'gallica'
    FROM generate_series(1, ${FOREIGN_PENDING_STUBS}) AS g`
})

after(async () => {
  await cleanupProject(project.id)
  await cleanupProject(stubsProject.id)
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
