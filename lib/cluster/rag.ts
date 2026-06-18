import "server-only"
// lib/cluster/rag.ts
// Facade that routes RAG queries to the real cluster or the fake in-process
// implementation based on the CLUSTER_MODE environment variable.
//
// CLUSTER_MODE=fake  (default) → FakeRagRunner (no network, no ML)
// CLUSTER_MODE=real             → throws (not yet implemented)
//
// All application code that needs RAG results imports ClusterRagClient from
// this module — never FakeRagRunner or a real cluster client directly.

// ---------------------------------------------------------------------------
// Public types (shared by fake and real implementations)
// ---------------------------------------------------------------------------

export interface RagPassage {
  /** BnF ARK identifier — opaque, verbatim from the cluster index. */
  ark: string
  /** Physical folio (1-based page number within the document). */
  folio: number
  /** Plain-text extract returned by the cluster. */
  snippet: string
  /** Cosine similarity score in [0, 1]. */
  score: number
  /** Byte-offset range of the snippet within the folio text. */
  charRange: [number, number]
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

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export const ClusterRagClient = {
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    const mode = process.env.CLUSTER_MODE ?? "fake"

    if (mode === "real") {
      throw new Error(
        "ClusterRagClient (real mode) not yet implemented — set CLUSTER_MODE=fake.",
      )
    }

    const { FakeRagRunner } = await import("./fake-rag")
    return FakeRagRunner.query(req)
  },
}
