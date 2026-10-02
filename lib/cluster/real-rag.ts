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
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { raceAbort } from "@/lib/mcp/abort"
import {
  DataclusterMcpClient,
  DataclusterMcpError,
  DataclusterMcpNotFoundError,
  DataclusterMcpProtocolError,
  DataclusterMcpToolError,
} from "./datacluster-mcp-client"
import type { DataclusterKeywordHit } from "./datacluster-mcp-client"
import { chunkToPassage, liveEntryIds, pickLiveEntryId, splitEntryText, toEntryContent } from "./rag-wire"
import { RAG_LOOKUP_STATUS } from "./rag"
import type {
  DocumentFoliosRequest,
  DocumentFoliosResult,
  RagEntryContentRequest,
  RagEntryContentResult,
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
 * Keyword hits requested per page when resolving an ARK to its entries. One
 * entry is the steady state; more than a page only after many lagging
 * re-ingests, which the lookup pages through.
 */
const ARK_LOOKUP_PAGE_SIZE = 20

/**
 * Resolve the project's numeric cluster dataset id, persisting it on first use.
 *
 * Reads `Project.clusterDatasetId` first and checks it still names dataset
 * `bnf-<projectId>`; on a miss (or a stale id), pages through the cluster's
 * dataset list matching that slug, writes the id back to the project, and
 * returns it.
 *
 * Throws DataclusterMcpNotFoundError when the walk completed and no dataset
 * has the slug — an inconsistency, since the rag tools only call us after an
 * ingestion has been committed — and a plain DataclusterMcpError when it gave
 * up after MAX_DATASET_PAGES without reaching the end (the dataset may exist).
 * The database awaits are raced against the caller's signal.
 */
async function resolveDatasetId(
  projectId: string,
  client: DataclusterMcpClient,
  signal: AbortSignal,
): Promise<number> {
  const project = await raceAbort(
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { clusterDatasetId: true },
    }),
    signal,
  )
  const slug = `${DATACLUSTER_DATASET_SLUG_PREFIX}${projectId}`

  // A cached id is checked before use: when the dataset was recreated (the
  // worker re-registers after `register_receipt_stale`), the old id names a
  // dead or foreign dataset, and every read would look like an empty corpus.
  if (project.clusterDatasetId !== null) {
    const cached = await cachedDatasetStillLive(client, project.clusterDatasetId, slug)
    if (cached) return project.clusterDatasetId
    console.warn(
      `[rag] project ${projectId}: cached cluster dataset ${project.clusterDatasetId} is no longer "${slug}"; re-resolving`,
    )
  }

  for (let page = 0; page < MAX_DATASET_PAGES; page++) {
    const offset = page * DATACLUSTER_LIST_PAGE_SIZE
    const datasets = await client.listDatasets(DATACLUSTER_LIST_PAGE_SIZE, offset)
    const match = datasets.find((d) => d.slug === slug)
    if (match) {
      await raceAbort(
        prisma.project.update({
          where: { id: projectId },
          data: { clusterDatasetId: match.id },
        }),
        signal,
      )
      return match.id
    }
    // Short page → the walk reached the end: the dataset does not exist.
    if (datasets.length < DATACLUSTER_LIST_PAGE_SIZE) {
      throw new DataclusterMcpNotFoundError(
        `No data-cluster dataset found for project ${projectId} (slug "${slug}"). ` +
          `The corpus may not have finished ingesting into the cluster.`,
      )
    }
  }

  throw new DataclusterMcpError(
    `Gave up resolving the data-cluster dataset of project ${projectId} (slug "${slug}") after ` +
      `${MAX_DATASET_PAGES} pages of ${DATACLUSTER_LIST_PAGE_SIZE} datasets without reaching the end of the list`,
  )
}

/**
 * Is the cached dataset id still this project's dataset? A tool error from
 * `datacluster_get_dataset` (the dataset is gone) or another slug means no.
 * Any other failure (transport, auth, protocol) propagates.
 */
async function cachedDatasetStillLive(client: DataclusterMcpClient, datasetId: number, slug: string): Promise<boolean> {
  try {
    return (await client.getDataset(datasetId)).slug === slug
  } catch (err) {
    if (err instanceof DataclusterMcpToolError) return false
    throw err
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
  if (filters.type !== undefined) out.docType = filters.type
  if (filters.subtype !== undefined) out.subtype = filters.subtype
  if (filters.lang !== undefined) out.lang = filters.lang
  if (filters.source !== undefined) out.source = filters.source
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
    const datasetId = await resolveDatasetId(req.projectId, client, req.signal)

    // The cluster's vector search filters by dataset_ids / entry_ids /
    // score_threshold only, so the request carries no facet filters (the
    // rag_query tool reports any it was given as ignored).
    const data = await client.vectorSearchChunks({
      query: req.query,
      limit: req.k,
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
    const datasetId = await resolveDatasetId(req.projectId, client, req.signal)

    const data = await client.keywordSearch({
      query: req.query,
      limit: req.limit,
      datasetIds: [datasetId],
      metadataFilters: toMetadataFilters(req.filters),
    })

    const hits = data.results
      .map(keywordHitToRag)
      .filter((h): h is RagKeywordHit => h !== null)

    // `total` is the cluster's count of matching entries, which mcp-datacluster
    // always reports (keyword_search.py). Without it the response is not one
    // the contract allows; `hits.length` would understate any paged search.
    const total = data.pagination?.total
    if (total === undefined) {
      throw new DataclusterMcpProtocolError("datacluster_keyword_search returned no pagination.total")
    }
    return { hits, total }
  },

  async getEntryContent(req: RagEntryContentRequest): Promise<RagEntryContentResult> {
    // get_entry_content is keyed by entry_id only, and entry ids are
    // cluster-wide: the id is read only if it is the live entry the ARK lookup
    // in THIS corpus project's dataset returns for the stated ARK. Offset and limit are
    // explicit on the request: the tool handler owns the defaults.
    const client = new DataclusterMcpClient({ signal: req.signal })
    const datasetId = await resolveDatasetId(req.projectId, client, req.signal)
    // Only the LIVE entry: a lagging tombstone's id would serve stale text
    // that the quote check (which reads the live entry) would then contradict.
    const liveEntryId = pickLiveEntryId(await lookupLiveEntryIds(client, datasetId, req.ark))
    if (liveEntryId !== req.entryId) {
      return { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryId }
    }
    const data = await client.getEntryContent({
      entryId: req.entryId,
      charOffset: req.charOffset,
      charLimit: req.charLimit,
    })
    return { status: RAG_LOOKUP_STATUS.FOUND, content: toEntryContent(data, req) }
  },

  /**
   * ARK → entry → whole processed text → per-folio map, scoped to the corpus
   * project's dataset (see lookupLiveEntryIds).
   */
  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    const client = new DataclusterMcpClient({ signal: req.signal })
    const datasetId = await resolveDatasetId(req.projectId, client, req.signal)
    const entryId = pickLiveEntryId(await lookupLiveEntryIds(client, datasetId, req.ark))
    if (entryId === null) return { status: RAG_LOOKUP_STATUS.ENTRY_NOT_FOUND }

    const content = await client.getEntryContent({ entryId, charOffset: 0, charLimit: 0 })
    return { status: RAG_LOOKUP_STATUS.FOUND, entryId, folios: splitEntryText(entryId, req.ark, content.text) }
  },
}

/**
 * The entry ids of `ark` in the dataset. The ARK is a string field of the
 * entry metadata schema, which data-cluster registers as Meili-filterable, so
 * an empty keyword query with `metadata_filters: {ark}` is the lookup. It
 * pages until it holds every match the cluster counted: an ARK may have
 * several entries (re-ingests whose tombstones lag), and the live one can only
 * be told from the complete set.
 */
async function lookupLiveEntryIds(
  client: DataclusterMcpClient,
  datasetId: number,
  ark: string,
): Promise<number[]> {
  const hits: DataclusterKeywordHit[] = []
  let total: number | undefined
  do {
    const page = await client.keywordSearch({
      query: "",
      datasetIds: [datasetId],
      metadataFilters: { ark },
      limit: ARK_LOOKUP_PAGE_SIZE,
      offset: hits.length,
    })
    total = page.pagination?.total
    if (page.results.length === 0) break
    hits.push(...page.results)
  } while (total !== undefined && hits.length < total)
  return liveEntryIds(hits, total, ark)
}
