// lib/cluster/real-rag.test.ts
// The real runner's ARK lookup with the MCP client stubbed: it pages through
// every entry of an ARK, rag_get_text reads only the live (newest) one, and
// the folio map comes from the entry's page chunks (listing stops at once for
// an older entry whose chunks are windows).
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import {
  DataclusterMcpClient,
  DataclusterMcpProtocolError,
  DataclusterMcpToolError,
  type DataclusterChunk,
} from "./datacluster-mcp-client"
import { datasetIdSchema, entryIdSchema } from "./composite-ids"
import type { EntryId } from "./composite-ids"
import { assembleEntryText } from "./folio-text"
import { RAG_LOOKUP_STATUS } from "./rag"
import { RealRagRunner } from "./real-rag"

process.env.DATACLUSTER_MCP_URL ??= "https://cluster.invalid/mcp"
process.env.CLUSTER_BEARER_TOKEN ??= "test-token"

const ARK = "ark:/12148/bpt6k822781z"
/** The MCP's composite ids: "cluster:dataset" and "cluster:dataset:entry". */
const dataset = (n: number) => datasetIdSchema.parse(`113:${n}`)
const entryNo = (n: number) => entryIdSchema.parse(`113:4242:${n}`)
let userId: string
let projectId: string
const proto = DataclusterMcpClient.prototype
const original = {
  keywordSearch: proto.keywordSearch,
  getEntryContent: proto.getEntryContent,
  getDataset: proto.getDataset,
  listDatasets: proto.listDatasets,
  vectorSearchChunks: proto.vectorSearchChunks,
}
/** The live entry's processed text and its chunks, as the cluster holds them; tests swap them. */
let entryText = "## Folio 1\n\nTexte"
let entryChunks: (offset: number) => DataclusterChunk[] = () => []
const chunkOffsets: number[] = []
/** The dataset the cluster currently has for the project; tests swap it. */
let liveDatasetId = dataset(4242)
const lookupOffsets: number[] = []
/** When the cluster created each entry; later entry numbers are created later unless a test says otherwise. */
const createdAtOf = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString()
let createdAt: (n: number) => string = createdAtOf
/** The dataset the ARK lookup's hits claim, and the pagination extras; tests swap them. */
let hitDataset = dataset(4242)
let unaddressable = 0

before(async () => {
  userId = (await createTestUser()).id
  projectId = (await createTestProject(userId, "real-rag-lookup")).id
  await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: dataset(4242) } })
  // 25 entries for one ARK (many lagging re-ingests): two pages of 20.
  const ids = Array.from({ length: 25 }, (_, i) => entryNo(100 + i))
  proto.keywordSearch = async function (input) {
    lookupOffsets.push(input.offset ?? 0)
    const page = ids.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 20))
    return {
      results: page.map((entry_id) => ({
        entry_id,
        dataset_id: hitDataset,
        score: 1,
        metadata: { ark: ARK, created_at: createdAt(Number(entry_id.split(":")[2])) },
      })),
      pagination: { total: ids.length, unaddressable },
    }
  }
  proto.getDataset = async function (datasetId) {
    if (datasetId !== liveDatasetId) throw new DataclusterMcpToolError("Dataset not found or access denied")
    return { dataset_id: datasetId, name: "n", slug: `bnf-${projectId}`, entry_count: 1 }
  }
  proto.listDatasets = async function () {
    return [{ dataset_id: liveDatasetId, name: "n", slug: `bnf-${projectId}`, entry_count: 1 }]
  }
  proto.getEntryContent = async function (input) {
    const total = [...entryText].length
    return { entry_id: input.entryId, text: entryText, char_offset: 0, char_limit: input.charLimit, total_length: total, has_more: false, next_offset: null }
  }
  proto.vectorSearchChunks = async function (input) {
    chunkOffsets.push(input.offset ?? 0)
    const results = entryChunks(input.offset ?? 0)
    return { results, total: results.length }
  }
})
after(async () => {
  proto.keywordSearch = original.keywordSearch
  proto.getEntryContent = original.getEntryContent
  proto.getDataset = original.getDataset
  proto.listDatasets = original.listDatasets
  proto.vectorSearchChunks = original.vectorSearchChunks
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

const request = (entryId: EntryId) => ({
  projectId,
  ark: ARK,
  entryId,
  charOffset: 0,
  charLimit: 50,
  signal: new AbortController().signal,
})

test("the ARK lookup pages through more than one page of entries instead of failing", async () => {
  lookupOffsets.length = 0
  const live = await RealRagRunner.getEntryContent(request(entryNo(124)))
  assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
  assert.deepEqual(lookupOffsets, [0, 20])
})

test("rag_get_text reads only the live entry; a stale id of the same ARK is refused with the live id", async () => {
  const stale = await RealRagRunner.getEntryContent(request(entryNo(103)))
  assert.deepEqual(stale, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryId: entryNo(124) })
})

test("a cached dataset id that no longer exists is re-resolved and re-cached, not read as an empty corpus", async () => {
  liveDatasetId = dataset(5151) // the dataset was recreated under a new id
  try {
    await withLookup({ hitDataset: dataset(5151) }, async () => {
      const live = await RealRagRunner.getEntryContent(request(entryNo(124)))
      assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
    })
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { clusterDatasetId: true } })
    assert.equal(project.clusterDatasetId, dataset(5151))
  } finally {
    liveDatasetId = dataset(4242)
    await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: dataset(4242) } })
  }
})

/** Run `body` with the ARK lookup's cluster behaviour swapped, restoring it after. */
async function withLookup(over: { hitDataset?: typeof hitDataset; unaddressable?: number; createdAt?: (n: number) => string }, body: () => Promise<void>) {
  const saved = { hitDataset, unaddressable, createdAt }
  hitDataset = over.hitDataset ?? hitDataset
  unaddressable = over.unaddressable ?? unaddressable
  createdAt = over.createdAt ?? createdAt
  try {
    await body()
  } finally {
    ;({ hitDataset, unaddressable, createdAt } = saved)
  }
}

test("an ARK lookup that leaves matches unaddressable is ENTRY_REINDEXING for the text and the folio map, never a guess", async () => {
  await withLookup({ unaddressable: 1 }, async () => {
    assert.deepEqual(await RealRagRunner.getEntryContent(request(entryNo(124))), { status: RAG_LOOKUP_STATUS.ENTRY_REINDEXING })
    assert.deepEqual(await RealRagRunner.getDocumentFolios(foliosRequest()), { status: RAG_LOOKUP_STATUS.ENTRY_REINDEXING })
  })
})

test("the live entry is the most recently created, not the highest entry number", async () => {
  // Entry 100 is the newest by creation time though it has the lowest number.
  await withLookup({ createdAt: (n) => createdAtOf(n === 100 ? 999 : n) }, async () => {
    const stale = await RealRagRunner.getEntryContent(request(entryNo(124)))
    assert.deepEqual(stale, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryId: entryNo(100) })
    const live = await RealRagRunner.getEntryContent(request(entryNo(100)))
    assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
  })
})

test("an ARK lookup entry without created_at is a protocol error, not a guess at the live entry", async () => {
  await withLookup({ createdAt: () => "" }, async () => {
    await assert.rejects(RealRagRunner.getEntryContent(request(entryNo(124))), DataclusterMcpProtocolError)
  })
})

test("a hit of another dataset never reaches the agent or rag_get_text: the lookup, the vector search and the keyword search refuse it", async () => {
  const foreign = dataset(9999)
  await withLookup({ hitDataset: foreign }, async () => {
    await assert.rejects(RealRagRunner.getEntryContent(request(entryNo(124))), /outside the project's dataset 113:4242/)
  })
  const savedVector = proto.vectorSearchChunks
  const savedKeyword = proto.keywordSearch
  const foreignChunk: DataclusterChunk = {
    entry_id: entryIdSchema.parse("113:9999:1"),
    dataset_id: foreign,
    score: 1,
    chunk_text: "x",
    metadata: { ark: ARK, folio: 1 },
  }
  proto.vectorSearchChunks = async () => ({ results: [foreignChunk], total: 1 })
  proto.keywordSearch = async () => ({
    results: [{ entry_id: foreignChunk.entry_id, dataset_id: foreign, score: 1, metadata: { ark: ARK } }],
    pagination: { total: 1 },
  })
  try {
    const signal = new AbortController().signal
    await assert.rejects(RealRagRunner.query({ projectId, query: "q", k: 5, signal }), DataclusterMcpProtocolError)
    await assert.rejects(RealRagRunner.keywordSearch({ projectId, query: "q", limit: 5, signal }), DataclusterMcpProtocolError)
  } finally {
    proto.vectorSearchChunks = savedVector
    proto.keywordSearch = savedKeyword
  }
})

test("a cached dataset id that is not composite (an integer left from the old contract) is re-resolved by slug and re-cached, never sent to the MCP", async () => {
  await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: "4242" } })
  const asked: unknown[] = []
  const savedGetDataset = proto.getDataset
  proto.getDataset = async function (datasetId) {
    asked.push(datasetId)
    return savedGetDataset.call(this, datasetId)
  }
  try {
    const live = await RealRagRunner.getEntryContent(request(entryNo(124)))
    assert.equal(live.status, RAG_LOOKUP_STATUS.FOUND)
    assert.deepEqual(asked, [], "the malformed value was not used as an id")
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { clusterDatasetId: true } })
    assert.equal(project.clusterDatasetId, dataset(4242), "the slug resolution overwrote it")
  } finally {
    proto.getDataset = savedGetDataset
    await prisma.project.update({ where: { id: projectId }, data: { clusterDatasetId: dataset(4242) } })
  }
})

/** A worker-v2 entry of `count` pages, its chunks in index order (one per page). */
function workerEntry(count: number, pageText: (folio: number) => string) {
  const pages = Array.from({ length: count }, (_, i) => ({ folio: i + 1, text: pageText(i + 1) }))
  const { text, ranges } = assembleEntryText(pages)
  const cps = [...text]
  const chunks: DataclusterChunk[] = pages.map((p, i) => ({
    entry_id: entryNo(124),
    dataset_id: dataset(4242),
    score: 1,
    chunk_text: cps.slice(ranges[i][0], ranges[i][1]).join(""),
    metadata: { ark: ARK, folio: p.folio, char_start: ranges[i][0], char_end: ranges[i][1] },
  }))
  return { text, chunks }
}

const foliosRequest = () => ({ projectId, ark: ARK, signal: new AbortController().signal })

async function withEntry<T>(text: string, chunks: (offset: number) => DataclusterChunk[], run: () => Promise<T>): Promise<T> {
  const saved = { entryText, entryChunks }
  entryText = text
  entryChunks = chunks
  chunkOffsets.length = 0
  try {
    return await run()
  } finally {
    entryText = saved.entryText
    entryChunks = saved.entryChunks
  }
}

test("the folio map of a worker-v2 entry comes from its page chunks, every page listed", async () => {
  const entry = workerEntry(250, (f) => (f === 7 ? "Rubrique\n\n## Folio 40\n\nsuite" : `Page ${f}`))
  const result = await withEntry(entry.text, (offset) => entry.chunks.slice(offset, offset + 100), () =>
    RealRagRunner.getDocumentFolios(foliosRequest()),
  )
  assert.ok(result.status === RAG_LOOKUP_STATUS.FOUND, `expected found, got ${result.status}`)
  assert.equal(result.folios.size, 250)
  // A page line that reads as a heading is the page's own text, not a folio.
  assert.equal(result.folios.get(7), "Rubrique\n\n## Folio 40\n\nsuite")
  assert.equal(result.folios.has(40), true)
  assert.equal(result.folios.get(40), "Page 40")
  assert.deepEqual([...chunkOffsets].sort((a, b) => a - b), [0, 100, 200])
})

test("an older entry whose chunks are windows stops listing after one page and falls back to its headings", async () => {
  const entry = workerEntry(250, (f) => `Page ${f}`)
  // Overlapping windows: offsets present, but not one page per chunk.
  const windows = (offset: number): DataclusterChunk[] =>
    Array.from({ length: 100 }, (_, i) => ({
      entry_id: entryNo(124),
      dataset_id: dataset(4242),
      score: 1,
      chunk_text: [...entry.text].slice(offset + i, offset + i + 30).join(""),
      metadata: { ark: ARK, folio: 1, char_start: offset + i, char_end: offset + i + 30 },
    }))
  const result = await withEntry(entry.text, windows, () => RealRagRunner.getDocumentFolios(foliosRequest()))
  assert.ok(result.status === RAG_LOOKUP_STATUS.FOUND, `expected found, got ${result.status}`)
  assert.equal(result.folios.size, 250)
  assert.deepEqual(chunkOffsets, [0])
})

test("a cluster that keeps returning full pages of chunks is a protocol error, not an endless listing", async () => {
  const entry = workerEntry(100, (f) => `Page ${f}`)
  await withEntry(entry.text, () => entry.chunks, async () => {
    await assert.rejects(RealRagRunner.getDocumentFolios(foliosRequest()), DataclusterMcpProtocolError)
  })
  assert.equal(chunkOffsets.length, 100)
})
