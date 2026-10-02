// lib/cluster/real-rag.test.ts
// The real runner's ARK lookup with the MCP client stubbed: it pages through
// every entry of an ARK, and rag_get_text reads only the live (newest) one.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { DataclusterMcpClient, DataclusterMcpToolError } from "./datacluster-mcp-client"
import { RAG_LOOKUP_STATUS } from "./rag"
import { RealRagRunner } from "./real-rag"

process.env.DATACLUSTER_MCP_URL ??= "https://cluster.invalid/mcp"
process.env.CLUSTER_BEARER_TOKEN ??= "test-token"

const ARK = "ark:/12148/bpt6k822781z"
let userId: string
let projectId: string
const proto = DataclusterMcpClient.prototype
const original = {
  keywordSearch: proto.keywordSearch,
  getEntryContent: proto.getEntryContent,
  getDataset: proto.getDataset,
  listDatasets: proto.listDatasets,
}
/** The dataset the cluster currently has for the project; tests swap it. */
let liveDatasetId = 4242
const lookupOffsets: number[] = []

before(async () => {
  userId = (await createTestUser()).id
  projectId = (await createTestProject(userId, "real-rag-lookup")).id
  await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: 4242 } })
  // 25 entries for one ARK (many lagging re-ingests): two pages of 20.
  const ids = Array.from({ length: 25 }, (_, i) => 100 + i)
  proto.keywordSearch = async function (input) {
    lookupOffsets.push(input.offset ?? 0)
    const page = ids.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 20))
    return {
      results: page.map((entry_id) => ({ entry_id, dataset_id: 4242, score: 1, metadata: { ark: ARK } })),
      pagination: { total: ids.length },
    }
  }
  proto.getDataset = async function (datasetId) {
    if (datasetId !== liveDatasetId) throw new DataclusterMcpToolError("Dataset not found or access denied")
    return { id: datasetId, name: "n", slug: `bnf-${projectId}`, entry_count: 1 }
  }
  proto.listDatasets = async function () {
    return [{ id: liveDatasetId, name: "n", slug: `bnf-${projectId}`, entry_count: 1 }]
  }
  proto.getEntryContent = async function (input) {
    return { entry_id: input.entryId, text: "## Folio 1\n\nTexte", char_offset: 0, char_limit: input.charLimit, total_length: 17, has_more: false, next_offset: null }
  }
})
after(async () => {
  proto.keywordSearch = original.keywordSearch
  proto.getEntryContent = original.getEntryContent
  proto.getDataset = original.getDataset
  proto.listDatasets = original.listDatasets
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

const request = (entryId: number) => ({
  projectId,
  ark: ARK,
  entryId,
  charOffset: 0,
  charLimit: 50,
  signal: new AbortController().signal,
})

test("the ARK lookup pages through more than one page of entries instead of failing", async () => {
  lookupOffsets.length = 0
  const live = await RealRagRunner.getEntryContent(request(124))
  assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
  assert.deepEqual(lookupOffsets, [0, 20])
})

test("rag_get_text reads only the live entry; a stale id of the same ARK is refused with the live id", async () => {
  const stale = await RealRagRunner.getEntryContent(request(103))
  assert.deepEqual(stale, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryId: 124 })
})

test("a cached dataset id that no longer exists is re-resolved and re-cached, not read as an empty corpus", async () => {
  liveDatasetId = 5151 // the dataset was recreated under a new id
  try {
    const live = await RealRagRunner.getEntryContent(request(124))
    assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { clusterDatasetId: true } })
    assert.equal(project.clusterDatasetId, 5151)
  } finally {
    liveDatasetId = 4242
    await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: 4242 } })
  }
})
