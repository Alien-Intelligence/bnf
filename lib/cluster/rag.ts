import "server-only"
// lib/cluster/rag.ts
// Facade that routes RAG queries to the real cluster or the fake in-process
// implementation based on the CLUSTER_MODE environment variable.
//
// CLUSTER_MODE=fake  (default) → FakeRagRunner (no network, no ML)
// CLUSTER_MODE=real             → RealRagRunner (data-cluster MCP, real Qdrant)
//
// All application code that needs RAG results imports ClusterRagClient from
// this module — never FakeRagRunner / RealRagRunner directly.

import type { DocumentFolios } from "./folio-text"

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
   * Character-offset range of the snippet within the entry's processed text
   * (start inclusive, end exclusive). Feed these to `rag_get_text` to pull the
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
  /** Human-readable document title (optional, denormalised for display). */
  title?: string
  /** Publication year (optional, denormalised for filtering). */
  year?: number
}

export interface RagQueryRequest {
  /** Project identifier — scopes the search to the project's vector store. */
  projectId: string
  /** Version snapshot the cluster should query against. */
  ingestedVersionId: string
  /** Free-text query issued by the research agent. */
  query: string
  /** Maximum number of passages to return (default: 12). */
  k?: number
  /** Server-side pre-filters applied before vector search. */
  filters?: {
    type?: string[]
    lang?: string[]
    source?: string[]
    yearFrom?: number
    yearTo?: number
  }
}

export interface RagQueryResponse {
  passages: RagPassage[]
  /** Total number of passages that survived filters and scored > 0. */
  total: number
  /** Version tag of the embedding model used (or "fake-rag-v1" in fake mode). */
  modelVersion: string
}

// --- Keyword search (entry-level, faceted) ---------------------------------

export interface RagKeywordRequest {
  projectId: string
  ingestedVersionId: string
  /** Free-text query — typo-tolerant. May be empty when filtering only. */
  query: string
  /** Maximum number of entry hits to return (default: 20). */
  limit?: number
  /** Exact-match facet filters on the corpus metadata. */
  filters?: {
    type?: string
    /** Gallica typedoc subcategory ("fascicules", "titres", "plan", …). */
    subtype?: string
    lang?: string
    source?: string
  }
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
  total: number
}

// --- Full-text retrieval (selective, paginated) ----------------------------

export interface RagEntryContentRequest {
  projectId: string
  /** Cluster entry id, obtained from a search result. */
  entryId: number
  /** Start offset into the processed text (default: 0). */
  charOffset?: number
  /** Characters to return; 0 = the rest of the document (default: 4000). */
  charLimit?: number
}

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
  | { status: "found"; entryId: number; folios: DocumentFolios }
  /** No cluster entry carries this ARK — not ingested, or dropped since. */
  | { status: "entry_not_found" }

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

function clusterMode(): "fake" | "real" {
  return (process.env.CLUSTER_MODE ?? "fake") === "real" ? "real" : "fake"
}

export const ClusterRagClient = {
  /** Semantic similarity search → ARK + folio + char-range passages. */
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    if (clusterMode() === "real") {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.query(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.query(req)
  },

  /** Keyword search → entry-level hits with snippets and facet filters. */
  async keywordSearch(req: RagKeywordRequest): Promise<RagKeywordResponse> {
    if (clusterMode() === "real") {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.keywordSearch(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.keywordSearch(req)
  },

  /** Selective full-text retrieval by entry id and character range. */
  async getEntryContent(req: RagEntryContentRequest): Promise<RagEntryContent> {
    if (clusterMode() === "real") {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.getEntryContent(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.getEntryContent(req)
  },

  /**
   * The whole processed text of a cited document, split per folio — what the
   * quote check compares a note's quotations against. One ARK → entry lookup
   * plus one full-content fetch; errors propagate as the cluster client's
   * typed `DataclusterMcp*Error`s (or an abort), and the caller decides.
   */
  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    if (clusterMode() === "real") {
      const { RealRagRunner } = await import("./real-rag")
      return RealRagRunner.getDocumentFolios(req)
    }
    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.getDocumentFolios(req)
  },
}
