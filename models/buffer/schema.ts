// models/buffer/schema.ts
// Domain constants + derived types for the research buffer ("tampon").
// No `import "server-only"` — schema is referenced by both client and server.
// No imports from other model directories — schema.ts is the foundation layer;
// the record kind comes from lib/documents/ark-kind.ts, shared with the corpus.
// See playbook/models.md import diagram.
import type { BufferItem } from "@/lib/generated/prisma/client"
import type { ArkKind } from "@/lib/documents/ark-kind"

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

/**
 * Background metadata enrichment of a BARE row (staged by ARK only, e.g. by
 * buffer_add) — lib/buffer/enricher.ts. Null = nothing to enrich (the row came
 * with its metadata, or it is no longer curated).
 */
export const BUFFER_ENRICH_STATUS = {
  /** Queued: the drain will resolve it (Document copy, then the broker). */
  PENDING: "pending",
  /** Metadata filled in. */
  RESOLVED: "resolved",
  /** Gave up (attempt ceiling, or the BnF does not know the ARK). */
  FAILED: "failed",
} as const

export type BufferEnrichStatus = (typeof BUFFER_ENRICH_STATUS)[keyof typeof BUFFER_ENRICH_STATUS]

/**
 * One level of buffer filter criteria. Multi-selects and the text arrays are
 * OR-within / AND-across dimensions; `title` / `creator` / `subject` match a
 * candidate containing ANY of the strings (case-insensitive, accent-sensitive).
 * Year bounds match by OVERLAP with [year, yearEnd ?? year], so a periodical
 * collection running 1861–1946 matches 1937. All fields optional; absent means
 * "no constraint on this dimension".
 */
export type BufferFilterFields = {
  type?: string[]
  kind?: ArkKind[]
  lang?: string[]
  source?: string[]
  title?: string[]
  creator?: string[]
  subject?: string[]
  yearFrom?: number
  yearTo?: number
  /** Include candidates with no date. Widens a year range; alone, selects them. */
  undated?: boolean
  /** true: candidates still waiting for background metadata (pending/failed);
   *  false: only resolved ones. */
  unresolved?: boolean
  /** Free text over title, creator, snippet and subjects. */
  q?: string
}

/**
 * The canonical (array-based) buffer filter set — the buffer's counterpart to
 * CorpusFilterSet. Queries, BufferService and the agent tools speak it; the
 * CSV `BufferFilters` (types.ts) is only the REST/UI boundary form, converted
 * by bufferFiltersToSet. `not` is a ONE-level exclusion: match = positive
 * clauses AND NOT(all `not` clauses). A candidate whose field is unknown (NULL)
 * for a dimension used in `not` is never matched by `not` — so "remove
 * everything not French" never deletes rows of unknown language; a dry run
 * reports how many were left out (`notUnknown`).
 */
export type BufferFilterSet = BufferFilterFields & { not?: BufferFilterFields }

/** DELETE /api/projects/:id/buffer — how many candidates were discarded. */
export type BufferDiscardResult = { discarded: number }

/** The facet dimensions buffer_stats can tabulate — the corpus set plus the
 *  record kind (arkKind). */
export type BufferFacetDimension = "period" | "type" | "lang" | "source" | "kind"

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
  | "creator"
  | "dateLabel"
  | "arkKind"
  | "subjects"
  | "enrichStatus"
>

/**
 * Facet distribution over the candidate set — the buffer's counterpart to
 * CorpusSnapshot.facets. Computed over candidate rows only; `undated` is the
 * count of candidates with `year IS NULL` (informational, excluded from the
 * period buckets). `period` bins by decade ("1880s", "1890s", …). `kind` counts
 * by record kind (arkKind). `unresolved` counts candidates whose metadata is
 * still being resolved in the background (enrichStatus pending) — filters do
 * not apply to them yet.
 */
export type BufferFacets = {
  type: Record<string, number>
  kind: Record<string, number>
  lang: Record<string, number>
  source: Record<string, number>
  period: Record<string, number>
  undated: number
  unresolved: number
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
