// models/corpus/types.ts
// Zod schemas for corpus API request validation and their inferred types.
// These are what route handlers validate against and what client hooks import.
//
// DB-derived shapes (CorpusSnapshot, DocumentRow, CorpusDiff) live in
// schema.ts, not here — per playbook/models.md.

import { z } from "zod"

// ---------------------------------------------------------------------------
// Client-side filter state
// ---------------------------------------------------------------------------

/**
 * CorpusFilters captures the active filter selections for the Constituer
 * comprehension panel. All fields are optional — missing means "no filter".
 * Multi-select fields (type, lang, source) are serialised as CSV strings in
 * URLSearchParams; use the helpers below to convert.
 */
export const corpusFiltersSchema = z.object({
  /** Comma-separated doc-type codes, e.g. "monographie,periodique" */
  type: z.string().optional(),
  /** Comma-separated BCP-47 language codes, e.g. "fr,la" */
  lang: z.string().optional(),
  /** Comma-separated source identifiers */
  source: z.string().optional(),
  /** Comma-separated AppSession ids — filter to docs a given session contributed */
  session: z.string().optional(),
  /**
   * Comma-separated ingestion classes (numérisation buckets):
   * "ocr" | "vision" | "sans_texte" | "non_numerise". A derived classification,
   * not a stored column — see classifyIngestion() / the snapshot query.
   */
  ingest: z.string().optional(),
  /** Decade start (inclusive), e.g. 1880 */
  yearFrom: z.coerce.number().int().optional(),
  /** Decade end (inclusive), e.g. 1889 */
  yearTo: z.coerce.number().int().optional(),
  /** When true, include documents with no date in the result set */
  undated: z.coerce.boolean().optional(),
  /** Free-text query; empty string is treated as absent */
  q: z.string().trim().min(1).optional(),
})

export type CorpusFilters = z.infer<typeof corpusFiltersSchema>

/**
 * Serialise a CorpusFilters object into URLSearchParams.
 * Multi-select fields are kept as a single CSV parameter.
 * Absent or undefined values are omitted.
 */
export function corpusFiltersToParams(filters: CorpusFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (filters.type) p.set("type", filters.type)
  if (filters.lang) p.set("lang", filters.lang)
  if (filters.source) p.set("source", filters.source)
  if (filters.session) p.set("session", filters.session)
  if (filters.ingest) p.set("ingest", filters.ingest)
  if (filters.yearFrom !== undefined) p.set("yearFrom", String(filters.yearFrom))
  if (filters.yearTo !== undefined) p.set("yearTo", String(filters.yearTo))
  if (filters.undated !== undefined) p.set("undated", String(filters.undated))
  if (filters.q !== undefined && filters.q.trim().length > 0) p.set("q", filters.q.trim())
  return p
}

/**
 * Deserialise URLSearchParams into a CorpusFilters object.
 * Missing parameters are absent on the returned object (not set to undefined).
 */
export function corpusFiltersFromParams(params: URLSearchParams): CorpusFilters {
  const raw: Record<string, string> = {}
  for (const [k, v] of params.entries()) {
    raw[k] = v
  }
  // Parse through the schema to coerce types and drop unknown keys.
  return corpusFiltersSchema.parse(raw)
}

/**
 * Remove a single value from a CSV multi-select filter.
 * If removing the last value the key is omitted from the returned object.
 * Returns a new CorpusFilters — never mutates the input.
 */
export function removeFromFilter(
  filters: CorpusFilters,
  key: "type" | "lang" | "source" | "session" | "ingest",
  value: string,
): CorpusFilters {
  const current = filters[key]
  if (!current) return filters
  const remaining = current
    .split(",")
    .filter((v) => v !== value)
    .join(",")
  return { ...filters, [key]: remaining || undefined }
}

/** Return a CorpusFilters with no active selections. */
export function emptyCorpusFilters(): CorpusFilters {
  return {}
}

/** True when at least one filter value is set. */
export function hasActiveFilters(filters: CorpusFilters): boolean {
  return (
    (!!filters.type && filters.type.length > 0) ||
    (!!filters.lang && filters.lang.length > 0) ||
    (!!filters.source && filters.source.length > 0) ||
    (!!filters.session && filters.session.length > 0) ||
    (!!filters.ingest && filters.ingest.length > 0) ||
    filters.yearFrom !== undefined ||
    filters.yearTo !== undefined ||
    filters.undated === true ||
    (!!filters.q && filters.q.length > 0)
  )
}

// ---------------------------------------------------------------------------
// ARK validation
// ---------------------------------------------------------------------------

/**
 * Validates a BnF ARK identifier.
 * Format: ark:/<NAAN>/<name> where <NAAN> is digits and <name> is
 * alphanumeric. ARKs are opaque — never constructed, never mutated.
 * Example: ark:/12148/bpt6k2839841
 */
export const arkSchema = z
  .string()
  .regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Corpus mutation inputs
// ---------------------------------------------------------------------------

export const addToCorpusSchema = z.object({
  /** The ARKs to add. Max 5000 per call (bulk add via agent, not API spam). */
  arks: z.array(arkSchema).min(1).max(5_000),
  /** Human-readable reason for this mutation (logged as version note). */
  reason: z.string().trim().min(1).max(300),
})

export type AddToCorpusInput = z.infer<typeof addToCorpusSchema>

export const removeFromCorpusSchema = z.object({
  /** The ARKs to remove. */
  arks: z.array(arkSchema).min(1).max(5_000),
  /** Human-readable reason for this mutation. */
  reason: z.string().trim().min(1).max(300),
})

export type RemoveFromCorpusInput = z.infer<typeof removeFromCorpusSchema>

// ---------------------------------------------------------------------------
// Diff query params
// ---------------------------------------------------------------------------

export const corpusDiffQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
})

export type CorpusDiffQuery = z.infer<typeof corpusDiffQuerySchema>
