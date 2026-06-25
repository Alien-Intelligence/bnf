import "server-only"
// lib/cluster/real-rag.ts
// Real RAG implementation for CLUSTER_MODE=real.
//
// Queries the data-cluster MCP (datacluster_vector_search_chunks) over the
// project's dataset and maps chunk hits to the app's RagPassage shape (ARK +
// folio + snippet + score), so the research agent can cite by ARK + folio.
//
// Dataset resolution: each project owns one cluster dataset, slug `bnf-<id>`.
// The numeric id is cached on `Project.clusterDatasetId`; the first query
// resolves it by listing datasets and matching the slug, then persists it.
//
// Consumed only via ClusterRagClient (lib/cluster/rag.ts) — never directly.

import {
  DATACLUSTER_DATASET_SLUG_PREFIX,
  DATACLUSTER_LIST_PAGE_SIZE,
  RAG_DEFAULT_K,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import {
  DataclusterMcpClient,
  DataclusterMcpNotFoundError,
} from "./datacluster-mcp-client"
import type {
  DataclusterChunk,
  DataclusterKeywordHit,
} from "./datacluster-mcp-client"
import type {
  RagEntryContent,
  RagEntryContentRequest,
  RagKeywordHit,
  RagKeywordRequest,
  RagKeywordResponse,
  RagPassage,
  RagQueryRequest,
  RagQueryResponse,
} from "./rag"

/** Hard cap on dataset-list pages walked while resolving a slug (anti-runaway). */
const MAX_DATASET_PAGES = 50

const MODEL_VERSION = "datacluster-mcp"

/**
 * Resolve the project's numeric cluster dataset id, persisting it on first use.
 *
 * Reads `Project.clusterDatasetId` first; on a miss, pages through the cluster's
 * dataset list matching slug `bnf-<projectId>`, writes the id back to the
 * project, and returns it.
 *
 * Throws DataclusterMcpNotFoundError if the project has no dataset in the
 * cluster — an inconsistency, since the rag_query tool only calls us after an
 * ingestion has been committed.
 */
async function resolveDatasetId(
  projectId: string,
  client: DataclusterMcpClient,
): Promise<number> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { clusterDatasetId: true },
  })
  if (project.clusterDatasetId !== null) return project.clusterDatasetId

  const slug = `${DATACLUSTER_DATASET_SLUG_PREFIX}${projectId}`

  for (let page = 0; page < MAX_DATASET_PAGES; page++) {
    const offset = page * DATACLUSTER_LIST_PAGE_SIZE
    const datasets = await client.listDatasets(DATACLUSTER_LIST_PAGE_SIZE, offset)
    const match = datasets.find((d) => d.slug === slug)
    if (match) {
      await prisma.project.update({
        where: { id: projectId },
        data: { clusterDatasetId: match.id },
      })
      return match.id
    }
    // Short page → no more datasets to walk.
    if (datasets.length < DATACLUSTER_LIST_PAGE_SIZE) break
  }

  throw new DataclusterMcpNotFoundError(
    `No data-cluster dataset found for project ${projectId} (slug "${slug}"). ` +
      `The corpus may not have finished ingesting into the cluster.`,
  )
}

/**
 * Map a cluster chunk to a RagPassage. Returns null when the chunk carries no
 * ARK — it cannot serve as a citation source, so it is dropped (never cited
 * without an ARK; never an invented one). Folio is preserved when present and
 * left null otherwise (single-image documents may have no folio).
 */
function chunkToPassage(chunk: DataclusterChunk): RagPassage | null {
  const { ark, folio, char_start, char_end, entry_id } = chunk.metadata
  if (typeof ark !== "string" || ark.length === 0) return null

  return {
    ark,
    folio: typeof folio === "number" ? folio : null,
    snippet: chunk.chunk_text,
    score: chunk.score,
    charRange: [
      typeof char_start === "number" ? char_start : 0,
      typeof char_end === "number" ? char_end : 0,
    ],
    entryId: typeof entry_id === "number" ? entry_id : null,
  }
}

/**
 * Translate the app's facet filters to keyword_search `metadata_filters`
 * (exact match on the dataset schema fields docType / lang / source).
 */
function toMetadataFilters(
  filters: RagKeywordRequest["filters"],
): Record<string, string> | undefined {
  if (!filters) return undefined
  const out: Record<string, string> = {}
  if (filters.type) out.docType = filters.type
  if (filters.subtype) out.subtype = filters.subtype
  if (filters.lang) out.lang = filters.lang
  if (filters.source) out.source = filters.source
  return Object.keys(out).length > 0 ? out : undefined
}

/** Map a keyword hit to the app shape; drop hits with no ARK (uncitable). */
function keywordHitToRag(hit: DataclusterKeywordHit): RagKeywordHit | null {
  const ark = hit.metadata?.ark
  if (typeof ark !== "string" || ark.length === 0) return null
  return {
    ark,
    entryId: hit.entry_id,
    title: typeof hit.metadata?.title === "string" ? hit.metadata.title : null,
    date: typeof hit.metadata?.date === "string" ? hit.metadata.date : null,
    score: hit.score,
    snippets: (hit.snippets ?? []).map((s) => s.text),
  }
}

export const RealRagRunner = {
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    const client = new DataclusterMcpClient()
    const datasetId = await resolveDatasetId(req.projectId, client)

    // NB: `req.filters` (type/lang/source/year) are NOT pushed down — the
    // cluster's vector search only filters by dataset_ids / entry_ids /
    // score_threshold. Same limitation as FakeRagRunner; the agent narrows
    // scope through the query text instead.
    const data = await client.vectorSearchChunks({
      query: req.query,
      limit: req.k ?? RAG_DEFAULT_K,
      datasetIds: [datasetId],
    })

    const passages = data.results
      .map(chunkToPassage)
      .filter((p): p is RagPassage => p !== null)

    return {
      passages,
      total: data.total,
      modelVersion: MODEL_VERSION,
    }
  },

  async keywordSearch(req: RagKeywordRequest): Promise<RagKeywordResponse> {
    const client = new DataclusterMcpClient()
    const datasetId = await resolveDatasetId(req.projectId, client)

    const data = await client.keywordSearch({
      query: req.query,
      limit: req.limit,
      datasetIds: [datasetId],
      metadataFilters: toMetadataFilters(req.filters),
    })

    const hits = data.results
      .map(keywordHitToRag)
      .filter((h): h is RagKeywordHit => h !== null)

    return { hits, total: data.pagination?.total ?? hits.length }
  },

  async getEntryContent(req: RagEntryContentRequest): Promise<RagEntryContent> {
    // NB: get_entry_content is keyed by entry_id only (no dataset scope on the
    // wire). The agent only ever receives entry ids from this project's
    // dataset-scoped searches, so it cannot reach another project's entries.
    const client = new DataclusterMcpClient()
    const data = await client.getEntryContent({
      entryId: req.entryId,
      charOffset: req.charOffset,
      charLimit: req.charLimit,
    })

    return {
      entryId: data.entry_id,
      text: data.text,
      charOffset: data.char_offset,
      charLimit: data.char_limit,
      totalLength: data.total_length,
      hasMore: data.has_more,
      nextOffset: data.next_offset,
    }
  },
}
