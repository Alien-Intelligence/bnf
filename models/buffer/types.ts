// models/buffer/types.ts
// Zod schemas for buffer request validation + their inferred types. What route
// handlers and agent tools validate against, and what client hooks import.
//
// DB-derived shapes (BufferRow, BufferSnapshot) live in schema.ts, not here —
// per playbook/models.md. No imports from other model directories: `arkSchema`
// is redefined here rather than imported from models/corpus (the import diagram
// forbids sideways model imports in types.ts).
import { z } from "zod"
import { BUFFER_ARK_KIND_VALUES, isBufferArkKind, type BufferFilterSet } from "./schema"

// ---------------------------------------------------------------------------
// ARK validation (opaque identifier — never constructed, never mutated)
// ---------------------------------------------------------------------------

/** ark:/<NAAN>/<name>, e.g. ark:/12148/bpt6k2839841. */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Buffer filter state (curation) — the buffer's counterpart to CorpusFilters,
// trimmed to the columns denormalised on a candidate row.
// ---------------------------------------------------------------------------

/** Split a CSV query value into a trimmed, non-empty array, or undefined. */
function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

/**
 * A query-string boolean. `z.coerce.boolean()` turns the STRING "false" into
 * `true` (any non-empty string is truthy) — the found bug that made
 * `?undated=false` return the undated candidates.
 */
const queryBooleanSchema = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")

export const bufferFiltersSchema = z.object({
  /** Comma-separated doc-type codes, e.g. "press,book". */
  type: z.string().optional(),
  /** Comma-separated record kinds (ARK_KIND values), e.g. "periodical_issue". */
  kind: z
    .string()
    .refine((v) => (splitCsv(v) ?? []).every(isBufferArkKind), {
      message: `record kinds: ${BUFFER_ARK_KIND_VALUES.join(", ")}`,
    })
    .optional(),
  /** Comma-separated BCP-47 language codes, e.g. "fr,la". */
  lang: z.string().optional(),
  /** Comma-separated source identifiers, e.g. "gallica,catalogue". */
  source: z.string().optional(),
  /** Comma-separated strings, a candidate matches when its title contains ANY. */
  title: z.string().optional(),
  /** Same, over the creator. */
  creator: z.string().optional(),
  /** Same, over the subject headings. */
  subject: z.string().optional(),
  /** Year lower bound (inclusive); matches by overlap with a range label. */
  yearFrom: z.coerce.number().int().optional(),
  /** Year upper bound (inclusive). */
  yearTo: z.coerce.number().int().optional(),
  /** "true"/"1": include candidates with no date; "false"/"0": do not. */
  undated: queryBooleanSchema.optional(),
  /** Free-text query over title, creator, snippet and subjects; empty is absent. */
  q: z.string().trim().min(1).optional(),
})

export type BufferFilters = z.infer<typeof bufferFiltersSchema>

/**
 * The CSV boundary form → the canonical filter set the queries take. Pure; the
 * one conversion the REST route uses (it used to redefine the schema and split
 * the CSV itself).
 */
export function bufferFiltersToSet(f: BufferFilters): BufferFilterSet {
  const type = splitCsv(f.type)
  const kind = splitCsv(f.kind)?.filter(isBufferArkKind)
  const lang = splitCsv(f.lang)
  const source = splitCsv(f.source)
  const title = splitCsv(f.title)
  const creator = splitCsv(f.creator)
  const subject = splitCsv(f.subject)
  // Absent keys, not `undefined` values: the set states only what was asked.
  return {
    ...(type !== undefined ? { type } : {}),
    ...(kind !== undefined && kind.length > 0 ? { kind } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(f.yearFrom !== undefined ? { yearFrom: f.yearFrom } : {}),
    ...(f.yearTo !== undefined ? { yearTo: f.yearTo } : {}),
    ...(f.undated !== undefined ? { undated: f.undated } : {}),
    ...(f.q !== undefined ? { q: f.q } : {}),
  }
}

/** True when at least one filter value is set. */
export function hasActiveBufferFilters(filters: BufferFilters): boolean {
  return (
    (!!filters.type && filters.type.length > 0) ||
    (!!filters.kind && filters.kind.length > 0) ||
    (!!filters.title && filters.title.length > 0) ||
    (!!filters.creator && filters.creator.length > 0) ||
    (!!filters.subject && filters.subject.length > 0) ||
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
  if (filters.kind) p.set("kind", filters.kind)
  if (filters.title) p.set("title", filters.title)
  if (filters.creator) p.set("creator", filters.creator)
  if (filters.subject) p.set("subject", filters.subject)
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
 *  (nullable columns); only the ARK is required. `docType` and `lang` are the
 *  CANONICAL codes (lib/buffer/classify.ts); the hit's own type label travels
 *  verbatim in `docTypeRaw`. `arkKind` is set by a producer that knows more
 *  than (ark, docType) — a `cb…/date` collection entry — and derived by
 *  registerCandidates otherwise. */
export const bufferCandidateSchema = z.object({
  ark: arkSchema,
  title: z.string().trim().min(1).max(500).optional(),
  year: z.number().int().optional(),
  docType: z.string().trim().min(1).max(80).optional(),
  docTypeRaw: z.string().trim().min(1).max(200).optional(),
  arkKind: z.enum(BUFFER_ARK_KIND_VALUES).optional(),
  lang: z.string().trim().min(1).max(20).optional(),
  source: z.string().trim().min(1).max(80).optional(),
  snippet: z.string().trim().min(1).max(2_000).optional(),
  creator: z.string().trim().min(1).max(500).optional(),
  publisher: z.string().trim().min(1).max(500).optional(),
  /** The BnF date string verbatim ("1861-1946", "1937-07-12"). */
  dateLabel: z.string().trim().min(1).max(100).optional(),
  /** Last year of a range label; absent for a single year. */
  yearEnd: z.number().int().optional(),
  /** Subject headings joined with " ; ". */
  subjects: z.string().trim().min(1).max(2_000).optional(),
  gallicaUrl: z.string().trim().min(1).max(500).optional(),
  catalogueUrl: z.string().trim().min(1).max(500).optional(),
  /** Provenance: the collapsing mode of the Gallica search that staged it. */
  searchCollapsing: z.boolean().optional(),
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
