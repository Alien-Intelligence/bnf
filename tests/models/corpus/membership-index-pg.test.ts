// tests/models/corpus/membership-index-pg.test.ts
// corpus_membership is keyed (version_id, ark) but is also read by project
// (CorpusQueries.allArksInProject) and referenced by project through the
// composite foreign key (project_id, ark) -> document. Without an index on
// (project_id, ark) the read scans the whole table and every Document delete
// scans it once per row, so deleting a large project's documents outruns the
// statement timeout. Real Postgres.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { seedCorpusDocuments, type SeedDocument } from "@/lib/testing/seed-corpus"
import { CorpusQueries } from "@/models/corpus/queries"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

const DOCUMENT_COUNT = 30_000
// Versions advanced on top of the seeded one; each carries the whole corpus.
const ADVANCE_COUNT = 3
// Another project's membership: the rest of the table every per-row foreign-key
// check has to get past without an index (production's table is millions of rows).
const BALLAST_DOCUMENT_COUNT = 100_000
const tag = randomBytes(4).toString("hex")
const arkOf = (kind: string, i: number) => `ark:/12148/${kind}${tag}${String(i).padStart(6, "0")}`
const doc = (ark: string): SeedDocument => ({
  ark,
  source: "gallica",
  title: "seed",
  resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
})

let user: User
let project: Project
let ballast: Project

/** A project holding `count` documents, then advanced `advances` more times by one document each. */
async function seededProject(label: string, count: number, advances: number): Promise<Project> {
  const created = await createTestProject(user.id, label)
  const actor = `user:${user.id}`
  await seedCorpusDocuments(created.id, Array.from({ length: count }, (_, i) => doc(arkOf(label.slice(0, 2), i))), actor)
  for (let i = 0; i < advances; i++) {
    await seedCorpusDocuments(created.id, [doc(arkOf(`${label.slice(0, 2)}x`, i))], actor)
  }
  return created
}

before(async () => {
  user = await createTestUser()
  project = await seededProject("membership-index", DOCUMENT_COUNT, ADVANCE_COUNT)
  ballast = await seededProject("ballast", BALLAST_DOCUMENT_COUNT, 0)
})

after(async () => {
  await cleanupProject(project.id)
  await cleanupProject(ballast.id)
  await deleteTestUser(user.id)
})

test("allArksInProject reads corpus_membership through an index on (project_id, ark)", async () => {
  // Seq scans are disabled so the plan shows whether an index COULD serve the
  // read, independently of the table sizes the planner happens to see.
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`
    const rows = await tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN SELECT DISTINCT ark FROM corpus_membership WHERE project_id = ${project.id}`
    return rows.map((r) => r["QUERY PLAN"]).join("\n")
  })
  assert.match(plan, /corpus_membership_project_id_ark_idx/, plan)
  assert.doesNotMatch(plan, /Seq Scan on corpus_membership/, plan)

  assert.equal((await CorpusQueries.allArksInProject(project.id)).length, DOCUMENT_COUNT + ADVANCE_COUNT)
})

test("a project with a large corpus deletes within the statement timeout", async () => {
  // The project teardown: membership first, then the documents the membership's
  // foreign key points at.
  await cleanupProject(project.id)
  assert.equal(await prisma.document.count({ where: { projectId: project.id } }), 0)
  assert.equal(await prisma.corpusMembership.count({ where: { projectId: project.id } }), 0)
})
