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
import { CorpusQueries } from "@/models/corpus/queries"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

const DOCUMENT_COUNT = 30_000
const VERSION_COUNT = 4
// Another project's membership: the rest of the table every per-row foreign-key
// check has to get past without an index (production's table is millions of rows).
const BALLAST_DOCUMENT_COUNT = 100_000
const tag = randomBytes(4).toString("hex")

let user: User
let project: Project
let ballast: Project

/** Seeds `count` resolved documents for `projectId` and a version holding them all. */
async function seedMembership(projectId: string, count: number, versions: number): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO document (project_id, ark, resolve_status, source, title)
    SELECT ${projectId}, 'ark:/12148/bpt6k' || ${tag} || lpad(g::text, 6, '0'),
           ${DOCUMENT_RESOLVE_STATUS.RESOLVED}, 'gallica', 'seed'
    FROM generate_series(1, ${count}) AS g`
  let parentId = (await CorpusQueries.headVersion(projectId)).id
  for (let seq = 2; seq < 2 + versions; seq++) {
    const version = await prisma.corpusVersion.create({
      data: { projectId, seq, status: CORPUS_VERSION_STATUS.SEALED, parentId, createdBy: `user:${user.id}` },
    })
    await prisma.$executeRaw`
      INSERT INTO corpus_membership (version_id, ark, project_id)
      SELECT ${version.id}, ark, project_id FROM document WHERE project_id = ${projectId}`
    parentId = version.id
  }
}

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "membership-index")
  ballast = await createTestProject(user.id, "membership-index ballast")
  await seedMembership(project.id, DOCUMENT_COUNT, VERSION_COUNT)
  await seedMembership(ballast.id, BALLAST_DOCUMENT_COUNT, 1)
})

after(async () => {
  for (const { id } of [project, ballast]) {
    await prisma.$executeRaw`DELETE FROM corpus_membership WHERE project_id = ${id}`
    await prisma.$executeRaw`DELETE FROM document WHERE project_id = ${id}`
    await cleanupProject(id)
  }
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

  assert.equal((await CorpusQueries.allArksInProject(project.id)).length, DOCUMENT_COUNT)
})

test("a project's documents delete within the statement timeout once its membership is gone", async () => {
  await prisma.$executeRaw`DELETE FROM corpus_membership WHERE project_id = ${project.id}`
  // No VACUUM or ANALYZE in between: this is the state a project deletion runs in.
  const deleted = await prisma.$executeRaw`DELETE FROM document WHERE project_id = ${project.id}`
  assert.equal(deleted, DOCUMENT_COUNT)
})
