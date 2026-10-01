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
  DataclusterEntryContent,
  DataclusterKeywordHit,
} from "./datacluster-mcp-client"
import { splitEntryFolios } from "./folio-text"
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
 * Map a cluster chunk to a RagPassage. Returns null when the chunk carries no
 * ARK — it cannot serve as a citation source, so it is dropped (never cited
 * without an ARK; never an invented one). Folio is preserved when present and
 * left null otherwise (single-image documents may have no folio). The char
 * range is set only when the chunk carries BOTH offsets (worker-v2 writes
 * them together); a chunk indexed before offsets existed reports `null`, not
 * a `[0, 0]` that would read as "the start of the document". Exported for
 * testing.
 */
export function chunkToPassage(chunk: DataclusterChunk): RagPassage | null {
  const { ark, folio, char_start, char_end, entry_id } = chunk.metadata
  if (typeof ark !== "string" || ark.length === 0) return null

  return {
    ark,
    folio: typeof folio === "number" ? folio : null,
    snippet: chunk.chunk_text,
    score: chunk.score,
    charRange:
      typeof char_start === "number" && typeof char_end === "number"
        ? [char_start, char_end]
        : null,
    entryId: typeof entry_id === "number" ? entry_id : null,
  }
}

/**
 * Normalise the three response modes of `datacluster_get_entry_content` into
 * the app's `RagEntryContent` (see `DataclusterEntryContent` for the shapes).
 * This is not a fallback for missing data: in full mode the text IS the rest
 * of the document from offset 0, so its length is the total, nothing follows,
 * and the next offset is its end — the documented semantics of that mode.
 * `charOffset` / `charLimit` are echoed from the request when the wire omits
 * them (full mode omits both; offset-only mode omits the limit). Exported for
 * testing.
 */
export function toEntryContent(
  data: DataclusterEntryContent,
  req: { entryId: number; charOffset: number; charLimit: number },
): RagEntryContent {
  const charOffset = data.char_offset ?? req.charOffset
  const end = charOffset + data.text.length
  return {
    entryId: data.entry_id ?? req.entryId,
    text: data.text,
    charOffset,
    charLimit: data.char_limit ?? req.charLimit,
    totalLength: data.total_length ?? end,
    hasMore: data.has_more ?? false,
    nextOffset: data.next_offset ?? end,
  }
}

/**
 * The live entry among the hits an ARK lookup returned: the highest id. A
 * re-ingest deletes the stale entry and then creates the new one
 * (worker-v2 LiveClusterSink.upsert), so when a tombstone lags the newest id
 * is the one the index serves (D13). `null` when nothing matched. Exported
 * for testing.
 */
export function pickLiveEntryId(hits: ReadonlyArray<{ entry_id: number }>): number | null {
  let best: number | null = null
  for (const h of hits) {
    if (best === null || h.entry_id > best) best = h.entry_id
  }
  return best
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
    //
    // The MCP's own defaults for an omitted offset / limit are 0 and 0 (the
    // whole document); resolving them here is what lets `toEntryContent` echo
    // the request faithfully when the wire omits the fields.
    const charOffset = req.charOffset ?? 0
    const charLimit = req.charLimit ?? 0
    const client = new DataclusterMcpClient()
    const data = await client.getEntryContent({
      entryId: req.entryId,
      charOffset,
      charLimit,
    })

    return toEntryContent(data, { entryId: req.entryId, charOffset, charLimit })
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
    const entryId = pickLiveEntryId(lookup.results)
    if (entryId === null) return { status: "entry_not_found" }

    const content = await client.getEntryContent({ entryId, charOffset: 0, charLimit: 0 })
    return { status: "found", entryId, folios: splitEntryFolios(content.text) }
  },
}
