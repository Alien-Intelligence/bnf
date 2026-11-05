// models/projects/cluster-dataset-id.test.ts
// The cached composite id of a project's data-cluster dataset: absent until
// resolved, written by ProjectService, read back verbatim by ProjectQueries —
// and a stale or malformed cached value is overwritten, not preserved.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import { datasetIdSchema } from "@/lib/cluster/composite-ids"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService } from "@/models/projects/service"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let userId: string
let projectId: string

before(async () => {
  userId = (await createTestUser()).id
  projectId = (await createTestProject(userId, "cluster-dataset-id")).id
})
after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

test("a project has no cached cluster dataset id until one is set", async () => {
  assert.equal(await ProjectQueries.clusterDatasetId(projectId), null)
})

test("setClusterDatasetId caches the composite id and clusterDatasetId reads it back; a later set replaces it", async () => {
  await ProjectService.setClusterDatasetId(projectId, datasetIdSchema.parse("113:6363"))
  assert.equal(await ProjectQueries.clusterDatasetId(projectId), "113:6363")
  await ProjectService.setClusterDatasetId(projectId, datasetIdSchema.parse("113:6352"))
  assert.equal(await ProjectQueries.clusterDatasetId(projectId), "113:6352")
})

test("a malformed cached value is returned verbatim for the caller to judge, then overwritten by a set", async () => {
  await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: "4242" } })
  assert.equal(await ProjectQueries.clusterDatasetId(projectId), "4242")
  await ProjectService.setClusterDatasetId(projectId, datasetIdSchema.parse("113:6363"))
  assert.equal(await ProjectQueries.clusterDatasetId(projectId), "113:6363")
})

test("clusterDatasetId of a project that does not exist throws", async () => {
  await assert.rejects(ProjectQueries.clusterDatasetId(randomUUID()))
})
