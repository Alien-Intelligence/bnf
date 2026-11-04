// lib/cluster/datacluster-contract.test.ts
// The data-cluster MCP's 0.3.0 wire contract, pinned against payloads captured
// from the live BnF cluster (contract-fixtures/, trimmed to a few results):
// every id is a composite string of platform ids ("cluster:dataset" /
// "cluster:dataset:entry"), top-level on search hits, and integer ids are
// refused by the server. The fixtures go through the real client (fetch
// stubbed) and the real mappers — nothing here is hand-shaped, so a change to
// the contract that the schemas do not follow fails here before it fails in
// production.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { datasetIdSchema, entryIdSchema } from "./composite-ids"
import { DataclusterMcpClient, DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import { chunkToPassage, folioChunksOf, liveEntryIds, pickLiveEntryId, toEntryContent } from "./rag-wire"

const rpcRequestSchema = z.object({
  method: z.string(),
  params: z.object({ arguments: z.unknown().optional() }).loose().optional(),
})

process.env.DATACLUSTER_MCP_URL ??= "https://cluster.invalid/mcp"
process.env.CLUSTER_BEARER_TOKEN ??= "test-token"

/** A captured `{success, data}` envelope, exactly as the tool returned it. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./contract-fixtures/${name}.json`, import.meta.url), "utf8"))
}

const realFetch = globalThis.fetch
let reply: unknown
let lastArguments: unknown

before(() => {
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = rpcRequestSchema.parse(JSON.parse(String(init?.body)))
    if (body.method === "initialize") return new Response("{}", { status: 200, headers: { "mcp-session-id": "s1" } })
    lastArguments = body.params?.arguments
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(reply) }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
})
after(() => {
  globalThis.fetch = realFetch
})

const client = () => new DataclusterMcpClient({ signal: new AbortController().signal })

const ARK = "ark:/12148/bpt6k3361716j"
const DATASET = datasetIdSchema.parse("113:6363")
const ENTRY = entryIdSchema.parse("113:6363:9195583")

test("list_datasets: items carry a composite dataset_id and no integer id; the slug resolves the project's dataset", async () => {
  reply = fixture("list_datasets")
  const datasets = await client().listDatasets(100, 0)
  assert.equal(datasets.length, 3)
  const slug = "bnf-22efccfe-6a5d-4aec-b972-28aab8aa6e72"
  assert.equal(datasets.find((d) => d.slug === slug)?.dataset_id, DATASET)
  assert.deepEqual(lastArguments, { limit: 100, offset: 0, include_schema: false, response_format: "json" })
})

test("get_dataset: the composite id is sent as dataset_id and comes back as dataset_id", async () => {
  reply = fixture("get_dataset")
  const dataset = await client().getDataset(DATASET)
  assert.equal(dataset.dataset_id, DATASET)
  assert.equal(dataset.slug, "bnf-22efccfe-6a5d-4aec-b972-28aab8aa6e72")
  assert.deepEqual(lastArguments, { dataset_id: "113:6363", response_format: "json" })
})

test("a dataset item whose id is the old integer is a protocol error", async () => {
  reply = { success: true, data: { datasets: [{ dataset_id: 6363, name: "n", slug: "s", entry_count: 1 }] } }
  await assert.rejects(client().listDatasets(100, 0), DataclusterMcpProtocolError)
  reply = { success: true, data: { datasets: [{ id: 6363, name: "n", slug: "s", entry_count: 1 }] } }
  await assert.rejects(client().listDatasets(100, 0), DataclusterMcpProtocolError)
})

test("vector search: chunks carry top-level composite ids and snake_case metadata, mapped to a passage with folio and char range", async () => {
  reply = fixture("vector_search")
  const data = await client().vectorSearchChunks({ query: "périodes sensibles", limit: 3, datasetIds: [DATASET] })
  assert.deepEqual(lastArguments, { query: "périodes sensibles", limit: 3, dataset_ids: ["113:6363"] })
  assert.equal(data.results.length, 3)

  const passage = chunkToPassage(data.results[0])
  assert.ok(passage)
  assert.equal(passage.ark, ARK)
  assert.equal(passage.entryId, ENTRY, "the entry id is the chunk's top-level entry_id")
  assert.equal(passage.folio, 50)
  assert.deepEqual(passage.charRange, [47945, 49454])

  // Another dataset of the same cluster: the id is passed through untouched.
  assert.equal(chunkToPassage(data.results[1])?.entryId, "113:766:2038356")
  // A chunk indexed before offsets existed: no range, never [0, 0].
  assert.equal(chunkToPassage(data.results[1])?.charRange, null)
})

test("vector search restricted to an entry: entry_ids go out as composite strings and every chunk is that entry's", async () => {
  reply = fixture("vector_search_entry_scoped")
  const data = await client().vectorSearchChunks({ query: ARK, datasetIds: [DATASET], entryIds: [ENTRY], limit: 100, offset: 0 })
  assert.deepEqual(lastArguments, { query: ARK, limit: 100, offset: 0, dataset_ids: ["113:6363"], entry_ids: ["113:6363:9195583"] })
  assert.ok(data.results.every((c) => c.entry_id === ENTRY))
  const pages = folioChunksOf(data.results)
  assert.deepEqual(
    pages.map((p) => [p.folio, p.charStart, p.charEnd]),
    [[103, 118336, 118353], [127, 146651, 146667], [10, 210, 294]],
  )
})

test("a chunk without a top-level entry_id, or with an integer one, is a protocol error — not a passage with no entry", async () => {
  const captured = fixture("vector_search") as { data: { results: Array<Record<string, unknown>> } }
  const chunk = captured.data.results[0]
  const { entry_id: _dropped, ...withoutEntry } = chunk
  for (const bad of [withoutEntry, { ...chunk, entry_id: 9195583 }, { ...chunk, entry_id: "113:6363" }]) {
    reply = { success: true, data: { results: [bad], total: 1 } }
    await assert.rejects(client().vectorSearchChunks({ query: "q" }), DataclusterMcpProtocolError, JSON.stringify(bad).slice(0, 80))
  }
})
test("keyword search: hits carry composite ids at the top level, camelCase entry metadata and the full pagination", async () => {
  reply = fixture("keyword_search")
  const page = await client().keywordSearch({ query: "école", limit: 1, datasetIds: [DATASET] })
  assert.deepEqual(lastArguments, { query: "école", response_format: "json", limit: 1, dataset_ids: ["113:6363"] })
  assert.equal(page.pagination?.total, 214)
  assert.equal(page.pagination?.unaddressable, 0)
  const [hit] = page.results
  assert.equal(hit.entry_id, "113:6352:8665823")
  assert.equal(hit.dataset_id, "113:6352")
  assert.equal(hit.metadata?.ark, "ark:/12148/bpt6k7058455m")
  assert.equal(hit.metadata?.title, "Le Plein air : revue illustrée de tous les sports")
  assert.equal(hit.metadata?.docType, "press")
})

test("ARK lookup: an empty query filtered on the ark gives the entry's composite id, and it is the live one", async () => {
  reply = fixture("keyword_search_ark_filter")
  const page = await client().keywordSearch({
    query: "",
    datasetIds: [DATASET],
    metadataFilters: { ark: "ark:/12148/bpt6k7058455m" },
    limit: 5,
    offset: 0,
  })
  assert.deepEqual(lastArguments, {
    query: "",
    response_format: "json",
    limit: 5,
    offset: 0,
    dataset_ids: ["113:6363"],
    metadata_filters: { ark: "ark:/12148/bpt6k7058455m" },
  })
  const ids = liveEntryIds(page.results, page.pagination?.total, "ark:/12148/bpt6k7058455m")
  assert.deepEqual(ids, ["113:6352:8665823"])
  assert.equal(pickLiveEntryId(ids), "113:6352:8665823")
})

test("get_entry_content: the composite entry_id is sent and echoed, and the page maps to the app's slice", async () => {
  reply = fixture("get_entry_content")
  const req = { entryId: ENTRY, charOffset: 0, charLimit: 1500 }
  const data = await client().getEntryContent(req)
  assert.deepEqual(lastArguments, { entry_id: "113:6363:9195583", char_offset: 0, char_limit: 1500 })
  assert.equal(data.entry_id, ENTRY)
  const slice = toEntryContent(data, req)
  assert.equal(slice.entryId, ENTRY)
  assert.equal(slice.totalLength, 308338)
  assert.equal(slice.hasMore, true)
  assert.equal(slice.nextOffset, 1500)
  assert.ok(slice.text.startsWith("## Folio 7"))
})

test("get_entry_content echoing another entry is a protocol error", async () => {
  const payload = fixture("get_entry_content") as { data: Record<string, unknown> }
  reply = { ...payload, data: { ...payload.data, entry_id: "113:6363:1" } }
  const req = { entryId: ENTRY, charOffset: 0, charLimit: 1500 }
  const echoed = await client().getEntryContent(req)
  assert.throws(() => toEntryContent(echoed, req), DataclusterMcpProtocolError)
})
