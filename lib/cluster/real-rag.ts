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
  DataclusterMcpProtocolError,
} from "./datacluster-mcp-client"
import type { DataclusterKeywordHit } from "./datacluster-mcp-client"
import { EntryFolioFormatError, splitEntryFolios } from "./folio-text"
import { chunkToPassage, pickLiveEntryId, toEntryContent } from "./rag-wire"
import type {
  DocumentFoliosRequest,
  DocumentFoliosResult,
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
 * Keyword hits requested when resolving an ARK to its entry. One is the
 * steady state; a few covers a re-ingest whose tombstone lagged (D13).
 */
const ARK_LOOKUP_LIMIT = 5

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
    const client = new DataclusterMcpClient({ signal: req.signal })
    const datasetId = await resolveDatasetId(req.projectId, client)

    // The cluster's vector search filters by dataset_ids / entry_ids /
    // score_threshold only, so the request carries no facet filters (the
    // rag_query tool reports any it was given as ignored).
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
    const client = new DataclusterMcpClient({ signal: req.signal })
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
    // Offset and limit are explicit on the request: the tool handler owns the
    // default, never the MCP (whose omitted limit means the whole document).
    const client = new DataclusterMcpClient({ signal: req.signal })
    const data = await client.getEntryContent({
      entryId: req.entryId,
      charOffset: req.charOffset,
      charLimit: req.charLimit,
    })
    return toEntryContent(data, req)
  },

  /**
   * ARK → entry → whole processed text → per-folio map. The ARK is a string
   * field of the entry metadata schema, which data-cluster registers as
   * Meili-filterable, so an empty keyword query with `metadata_filters: {ark}`
   * is the lookup. Scoped to the corpus project's dataset.
   */
  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    const client = new DataclusterMcpClient({ signal: req.signal })
    const datasetId = await resolveDatasetId(req.projectId, client)

    const lookup = await client.keywordSearch({
      query: "",
      datasetIds: [datasetId],
      metadataFilters: { ark: req.ark },
      limit: ARK_LOOKUP_LIMIT,
    })
    const entryId = pickLiveEntryId(lookup.results, req.ark)
    if (entryId === null) return { status: "entry_not_found" }

    const content = await client.getEntryContent({ entryId, charOffset: 0, charLimit: 0 })
    try {
      return { status: "found", entryId, folios: splitEntryFolios(content.text) }
    } catch (err) {
      if (err instanceof EntryFolioFormatError) {
        throw new DataclusterMcpProtocolError(
          `entry ${entryId} (${req.ark}) is not in the worker's folio format: ${err.message}`,
          err,
        )
      }
      throw err
    }
  },
}
