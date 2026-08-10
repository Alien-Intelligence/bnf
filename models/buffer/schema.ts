// models/buffer/schema.ts
// Domain constants + derived types for the research buffer ("tampon").
// No `import "server-only"` — schema is referenced by both client and server.
// No imports from other model directories — schema.ts is the foundation layer.
// See playbook/models.md import diagram.
import type { BufferItem } from "@/lib/generated/prisma/client"

export type { BufferItem }

// ---------------------------------------------------------------------------
// Domain status enum (String column in prisma/schema.prisma — no native enum)
// ---------------------------------------------------------------------------

export const BUFFER_STATUS = {
  /** Surfaced by a search, not yet committed. The only status the agent curates. */
  CANDIDATE: "candidate",
  /** Moved into the versioned corpus by buffer_commit. Kept for provenance. */
  COMMITTED: "committed",
  /** Explicitly dropped by the user/agent. Kept out of the candidate set. */
  DISCARDED: "discarded",
} as const

export type BufferStatus = (typeof BUFFER_STATUS)[keyof typeof BUFFER_STATUS]

/** The facet dimensions buffer_stats can tabulate — mirrors the corpus set. */
export type BufferFacetDimension = "period" | "type" | "lang" | "source"

// ---------------------------------------------------------------------------
// Composite shapes returned to the API / agent-tool layer
// ---------------------------------------------------------------------------

/** One candidate as shown in the buffer panel + the buffer_list tool. */
export type BufferRow = Pick<
  BufferItem,
  | "id"
  | "ark"
  | "title"
  | "year"
  | "docType"
  | "lang"
  | "source"
  | "snippet"
  | "originQuery"
  | "createdAt"
>

/**
 * Facet distribution over the candidate set — the buffer's counterpart to
 * CorpusSnapshot.facets. Computed over candidate rows only; `undated` is the
 * count of candidates with `year IS NULL` (informational, excluded from the
 * period buckets). `period` bins by decade ("1880s", "1890s", …).
 */
export type BufferFacets = {
  type: Record<string, number>
  lang: Record<string, number>
  source: Record<string, number>
  period: Record<string, number>
  undated: number
}

/**
 * The buffer's comprehension shape (buffer_stats + the panel header). `total`
 * is the candidate count within the active filters. `sample` is bounded
 * (BUFFER_SAMPLE_SIZE) — never use `sample.length` as a proxy for `total`.
 */
export type BufferSnapshot = {
  total: number
  facets: BufferFacets
  sample: BufferRow[]
}

/**
 * A crossed-facet table — buffer_stats with `cross_facets`. `cells` is sparse
 * (non-zero combinations only), sorted by `count` descending, so
 * "1880s × press = 42" is a single-call insight for locating a sub-population.
 */
export type BufferCrossFacets = {
  dims: [BufferFacetDimension, BufferFacetDimension]
  cells: { a: string; b: string; count: number }[]
}
