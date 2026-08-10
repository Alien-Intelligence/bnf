// models/buffer/types.ts
// Zod schemas for buffer request validation + their inferred types. What route
// handlers and agent tools validate against, and what client hooks import.
//
// DB-derived shapes (BufferRow, BufferSnapshot) live in schema.ts, not here —
// per playbook/models.md. No imports from other model directories: `arkSchema`
// is redefined here rather than imported from models/corpus (the import diagram
// forbids sideways model imports in types.ts).
import { z } from "zod"

// ---------------------------------------------------------------------------
// ARK validation (opaque identifier — never constructed, never mutated)
// ---------------------------------------------------------------------------

/** ark:/<NAAN>/<name>, e.g. ark:/12148/bpt6k2839841. */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Buffer filter state (curation) — the buffer's counterpart to CorpusFilters,
// trimmed to the columns denormalised on a candidate row.
// ---------------------------------------------------------------------------

export const bufferFiltersSchema = z.object({
  /** Comma-separated doc-type codes, e.g. "press,book". */
  type: z.string().optional(),
  /** Comma-separated BCP-47 language codes, e.g. "fr,la". */
  lang: z.string().optional(),
  /** Comma-separated source identifiers, e.g. "gallica,catalogue". */
  source: z.string().optional(),
  /** Decade start (inclusive), e.g. 1880. */
  yearFrom: z.coerce.number().int().optional(),
  /** Decade end (inclusive), e.g. 1889. */
  yearTo: z.coerce.number().int().optional(),
  /** When true, include candidates with no date in the result set. */
  undated: z.coerce.boolean().optional(),
  /** Free-text query over title + snippet; empty string is treated as absent. */
  q: z.string().trim().min(1).optional(),
})

export type BufferFilters = z.infer<typeof bufferFiltersSchema>

/** True when at least one filter value is set. */
export function hasActiveBufferFilters(filters: BufferFilters): boolean {
  return (
    (!!filters.type && filters.type.length > 0) ||
    (!!filters.lang && filters.lang.length > 0) ||
    (!!filters.source && filters.source.length > 0) ||
    filters.yearFrom !== undefined ||
    filters.yearTo !== undefined ||
    filters.undated === true ||
    (!!filters.q && filters.q.length > 0)
  )
}

/** Serialise BufferFilters into URLSearchParams (multi-selects stay CSV). */
export function bufferFiltersToParams(filters: BufferFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (filters.type) p.set("type", filters.type)
  if (filters.lang) p.set("lang", filters.lang)
  if (filters.source) p.set("source", filters.source)
  if (filters.yearFrom !== undefined) p.set("yearFrom", String(filters.yearFrom))
  if (filters.yearTo !== undefined) p.set("yearTo", String(filters.yearTo))
  if (filters.undated !== undefined) p.set("undated", String(filters.undated))
  if (filters.q !== undefined && filters.q.trim().length > 0) p.set("q", filters.q.trim())
  return p
}

/** Deserialise URLSearchParams into BufferFilters (coerces + drops unknowns). */
export function bufferFiltersFromParams(params: URLSearchParams): BufferFilters {
  const raw: Record<string, string> = {}
  for (const [k, v] of params.entries()) raw[k] = v
  return bufferFiltersSchema.parse(raw)
}

// ---------------------------------------------------------------------------
// Mutation inputs
// ---------------------------------------------------------------------------

/** A candidate hit written to the buffer by a search tool. Metadata is optional
 *  (nullable columns); only the ARK is required. */
export const bufferCandidateSchema = z.object({
  ark: arkSchema,
  title: z.string().trim().min(1).max(500).optional(),
  year: z.number().int().optional(),
  docType: z.string().trim().min(1).max(80).optional(),
  lang: z.string().trim().min(1).max(20).optional(),
  source: z.string().trim().min(1).max(80).optional(),
  snippet: z.string().trim().min(1).max(2_000).optional(),
})

export type BufferCandidateInput = z.infer<typeof bufferCandidateSchema>

/** Manual add of bare ARKs to the buffer (no search). */
export const bufferAddSchema = z.object({
  arks: z.array(arkSchema).min(1).max(5_000),
})

export type BufferAddInput = z.infer<typeof bufferAddSchema>

/** Drop candidates from the buffer by ARK (mark `discarded`). */
export const bufferDiscardSchema = z.object({
  arks: z.array(arkSchema).min(1).max(5_000),
})

export type BufferDiscardInput = z.infer<typeof bufferDiscardSchema>

/** Commit the buffer's candidates into the versioned corpus. */
export const bufferCommitSchema = z.object({
  /** Human-readable reason, logged as the corpus version note. */
  reason: z.string().trim().min(1).max(300),
})

export type BufferCommitInput = z.infer<typeof bufferCommitSchema>
