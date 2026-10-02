import "server-only"
// lib/cluster/rag.ts
// Facade that routes RAG queries to the real cluster or the fake in-process
// implementation based on the CLUSTER_MODE environment variable.
//
// CLUSTER_MODE=fake            → FakeRagRunner (no network, no ML)
// CLUSTER_MODE=real             → RealRagRunner (data-cluster MCP, real Qdrant)
// unset or any other value      → throws (lib/cluster/mode.ts)
//
// All application code that needs RAG results imports ClusterRagClient from
// this module — never FakeRagRunner / RealRagRunner directly.
//
// Corpus versions: the cluster index has NO notion of a corpus version. Chunks
// and entries carry no version field, and no MCP tool filters by one, so every
// read sees the project dataset's current entries — including entries an
// in-flight ingest has already written. The agent tools gate on the project
// HAVING a committed ingested version (ingestion-guard.ts); they cannot scope a
// read to it, and these requests do not pretend to.
//
// Every request carries the caller's AbortSignal (the turn's `ctx.signal`), and
// every offset and length is in Unicode code points (folio-text.ts).

import type { DocumentFolios } from "./folio-text"
import { CLUSTER_MODE, clusterMode } from "./mode"

// ---------------------------------------------------------------------------
// Public types (shared by fake and real implementations)
// ---------------------------------------------------------------------------

export interface RagPassage {
  /** BnF ARK identifier — opaque, verbatim from the cluster index. */
  ark: string
  /**
   * Physical folio (1-based page number within the document), or null when the
   * source chunk has no folio (e.g. single-image documents). A citation
   * requires a folio — the agent cites in prose, not `[[ark|label|folio]]`,
   * when this is null (see playbook/citations.md). Never invented.
   */
  folio: number | null
  /** Plain-text extract returned by the cluster. */
  snippet: string
  /** Cosine similarity score in [0, 1]. */
  score: number
  /**
   * Code-point range of the snippet within the entry's processed text (start
   * inclusive, end exclusive). Feed these to `rag_get_text` to pull the
   * surrounding context selectively.
   *
   * `null` when the chunk was indexed before worker-v2 wrote offsets
   * (`char_start` / `char_end` in the chunk metadata); a re-ingest fills it.
   * Never `[0, 0]` as a stand-in — the agent is told to treat the range as
   * optional, not to read from offset 0.
   */
  charRange: [number, number] | null
  /**
   * Cluster entry id this chunk belongs to (null if the cluster omitted it).
   * The handle for `rag_get_text` — chain search → full text with it.
   */
  entryId: number | null
}

export interface RagQueryRequest {
  /** The CORPUS project id — scopes the search to its dataset. */
  projectId: string
  /** Free-text query issued by the research agent. */
  query: string
  /** Passages to return (the rag_query handler applies RAG_DEFAULT_K). */
  k: number
  // No filters: the cluster's vector search filters by dataset / entry / score
  // only. Facet filtering is keyword search's (RagKeywordRequest.filters).
  /** Bounds every cluster await (the turn's signal). */
  signal: AbortSignal
}

export interface RagQueryResponse {
  passages: RagPassage[]
  /** Total number of passages the search matched. */
  total: number
  /** Version tag of the embedding model used (FAKE_RAG_MODEL_VERSION in fake mode). */
  modelVersion: string
}

// --- Keyword search (entry-level, faceted) ---------------------------------

export interface RagKeywordRequest {
  /** The CORPUS project id — scopes the search to its dataset. */
  projectId: string
  /** Free-text query — typo-tolerant. May be empty when filtering only. */
  query: string
  /** Entry hits to return (the handler applies RAG_KEYWORD_DEFAULT_LIMIT). */
  limit: number
  /** Exact-match facet filters on the corpus metadata. */
  filters?: {
    type?: string
    /** Gallica typedoc subcategory ("fascicules", "titres", "plan", …). */
    subtype?: string
    lang?: string
    source?: string
  }
  /** Bounds every cluster await (the turn's signal). */
  signal: AbortSignal
}

export interface RagKeywordHit {
  /** BnF ARK — the citation/document key. */
  ark: string
  /** Cluster entry id — the handle for `rag_get_text`. */
  entryId: number
  /** Document title, when known. */
  title: string | null
  /** Raw BnF date string (may be a range), when known. */
  date: string | null
  /** Relevance score (MeiliSearch ranking, not a cosine similarity). */
  score: number
  /** Contextual snippets around the matched terms. */
  snippets: string[]
}

export interface RagKeywordResponse {
  hits: RagKeywordHit[]
  /** Entries the search matched in all (may exceed `hits.length` when limited). */
  total: number
}

// --- Full-text retrieval (selective, paginated) ----------------------------

export interface RagEntryContentRequest {
  /** The CORPUS project id — the dataset the entry must belong to. */
  projectId: string
  /**
   * The ARK of the search result the entry id came from. The runner reads the
   * entry only if the ARK lookup in the corpus project's dataset returns this
   * id for it: entry ids are cluster-wide, so a model-supplied id alone could
   * name another project's (another client's) document.
   */
  ark: string
  /** Cluster entry id, obtained from a search result. */
  entryId: number
  /** Start offset into the processed text, in code points. */
  charOffset: number
  /**
   * Code points to return; 0 = the rest of the document. Always explicit: the
   * default is applied once, by the rag_get_text tool handler.
   */
  charLimit: number
  /** Bounds every cluster await (the turn's signal). */
  signal: AbortSignal
}

/** Outcomes of a facade read that resolves an ARK to its entry. */
export const RAG_LOOKUP_STATUS = {
  FOUND: "found",
  /** No entry of the corpus project's dataset carries this ARK. */
  ENTRY_NOT_FOUND: "entry_not_found",
  /** The ARK has entries in the dataset, but not the requested entry id. */
  ENTRY_NOT_IN_CORPUS: "entry_not_in_corpus",
} as const

export type RagEntryContentResult =
  | { status: typeof RAG_LOOKUP_STATUS.FOUND; content: RagEntryContent }
  | { status: typeof RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS; liveEntryIds: number[] }

export interface RagEntryContent {
  entryId: number
  text: string
  charOffset: number
  charLimit: number
  totalLength: number
  hasMore: boolean
  nextOffset: number
}

// --- Whole-document folio text --------------------------------------------

export interface DocumentFoliosRequest {
  /**
   * The CORPUS project id (`ctx.corpusProjectId`, resolved through
   * lib/authz/corpus-source.ts) — the dataset a derived workspace's citations
   * point into is its source's. Never `ctx.projectId`.
   */
  projectId: string
  /** The cited document's ARK, verbatim. */
  ark: string
  /** Bounds every cluster await; the caller composes its own budget into it. */
  signal: AbortSignal
}

export type DocumentFoliosResult =
  | { status: typeof RAG_LOOKUP_STATUS.FOUND; entryId: number; folios: DocumentFolios }
  /** No cluster entry carries this ARK — not ingested, or dropped since. */
  | { status: typeof RAG_LOOKUP_STATUS.ENTRY_NOT_FOUND }

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------


export const ClusterRagClient = {
  /** Semantic similarity search → ARK + folio + char-range passages. */
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    if (clusterMode() === CLUSTER_MODE.REAL) {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.query(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.query(req)
  },

  /** Keyword search → entry-level hits with snippets and facet filters. */
  async keywordSearch(req: RagKeywordRequest): Promise<RagKeywordResponse> {
    if (clusterMode() === CLUSTER_MODE.REAL) {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.keywordSearch(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.keywordSearch(req)
  },

  /**
   * Selective full-text retrieval by entry id and character range — only for
   * an entry the ARK lookup in the corpus project's dataset vouches for.
   */
  async getEntryContent(req: RagEntryContentRequest): Promise<RagEntryContentResult> {
    if (clusterMode() === CLUSTER_MODE.REAL) {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.getEntryContent(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.getEntryContent(req)
  },

  /**
   * The whole processed text of a cited document, split per folio — what the
   * quote check compares a note's quotations against. One ARK → entry lookup
   * plus one full-content fetch. Failures propagate as the cluster client's
   * typed `DataclusterMcp*Error`s — a malformed lookup or text that is not in
   * the worker's folio format is a `DataclusterMcpProtocolError` — or as the
   * request signal's abort; the caller decides. (A failure to resolve the
   * project's dataset id through the database propagates as that error.)
   */
  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    if (clusterMode() === CLUSTER_MODE.REAL) {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.getDocumentFolios(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.getDocumentFolios(req)
  },
}
