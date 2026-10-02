// models/buffer/types.ts
// Zod schemas for buffer request validation + their inferred types. What route
// handlers and agent tools validate against, and what client hooks import.
//
// DB-derived shapes (BufferRow, BufferSnapshot) live in schema.ts, not here —
// per playbook/models.md. No imports from other model directories: `arkSchema`
// is redefined here rather than imported from models/corpus (the import diagram
// forbids sideways model imports in types.ts).
import { z } from "zod"
import { ARK_KIND_VALUES } from "@/lib/documents/ark-kind"
import { textAnySchema } from "@/lib/filters"
import type { BufferFilterFields, BufferFilterSet } from "./schema"

// ---------------------------------------------------------------------------
// ARK validation (opaque identifier — never constructed, never mutated)
// ---------------------------------------------------------------------------

/** ark:/<NAAN>/<name>, e.g. ark:/12148/bpt6k2839841. */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Buffer filters — ONE definition for the agent tools AND the REST route
// (GET /api/projects/:id/buffer decodes its query string into this shape and
// validates it with this schema; the client hook encodes the same shape).
// Array-based, like the corpus filters.
// ---------------------------------------------------------------------------

export const bufferFilterFieldsSchema = z.object({
  type: z
    .array(z.string())
    .optional()
    .describe(
      "Canonical doc-type codes to match: book | press | image | map | manuscript | score | " +
        "audio | video | object | poster | estampe | enlum | charte | other | text (« texte " +
        'imprimé, nature indéterminée »), e.g. ["press","book"].',
    ),
  kind: z
    .array(z.enum(ARK_KIND_VALUES))
    .optional()
    .describe(
      "Record kinds to match: periodical_issue | periodical_collection | monograph | image | " +
        "catalogue_notice | other_document | unknown.",
    ),
  lang: z
    .array(z.string())
    .optional()
    .describe('Language codes to match (ISO 639-1, e.g. ["fr","la","de"]).'),
  source: z
    .array(z.string())
    .optional()
    .describe('Sources to match: "gallica" | "catalogue" | "other".'),
  title: textAnySchema
    .optional()
    .describe(
      "Contains ANY of these strings in the title (case-insensitive, accent-sensitive — pass " +
        'variants: ["Algérie","Algerie"]).',
    ),
  creator: textAnySchema
    .optional()
    .describe("Contains ANY of these strings in the creator/author (case-insensitive, accent-sensitive)."),
  subject: textAnySchema
    .optional()
    .describe("Contains ANY of these strings in the subject headings (case-insensitive, accent-sensitive)."),
  yearFrom: z
    .number()
    .int()
    .optional()
    .describe("Year lower bound, inclusive. A date RANGE matches when it overlaps (a 1861–1946 run matches 1937)."),
  yearTo: z.number().int().optional().describe("Year upper bound, inclusive (overlap, as yearFrom)."),
  undated: z
    .boolean()
    .optional()
    .describe("With a year range: also match undated candidates. Alone: match only undated candidates."),
  unresolved: z
    .boolean()
    .optional()
    .describe(
      "true: candidates whose metadata is still being resolved in the background (filters on " +
        "title/type/date cannot see them yet); false: only resolved ones.",
    ),
  q: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text match over title, creator, snippet and subjects."),
})

export const bufferFilterSetSchema = bufferFilterFieldsSchema
  .extend({
    not: bufferFilterFieldsSchema
      .optional()
      .describe(
        "EXCLUDE candidates matching ALL these criteria. A candidate whose field is unknown for a " +
          "criterion used here is never excluded (reported as notUnknown on a dry run).",
      ),
  })
  .describe(
    "Metadata filters over the buffer candidates, to MATCH. Omit a field to leave it unconstrained.",
  )


/** How each filter field travels in a query string. Keyed by the schema's own
 *  keys (a field added to the schema without a codec is a type error). */
const BUFFER_FILTER_PARAM_CODEC = {
  type: "list",
  kind: "list",
  lang: "list",
  source: "list",
  title: "list",
  creator: "list",
  subject: "list",
  yearFrom: "number",
  yearTo: "number",
  undated: "boolean",
  unresolved: "boolean",
  q: "text",
} as const satisfies Record<keyof z.infer<typeof bufferFilterFieldsSchema>, "list" | "number" | "boolean" | "text">

type BufferFilterField = keyof typeof BUFFER_FILTER_PARAM_CODEC

/** The `not` fields travel as `not.<field>` query parameters. */
const NOT_PARAM_PREFIX = "not."

/** Split a CSV query value into a trimmed, non-empty array, or undefined. */
function splitCsv(value: string): string[] | undefined {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

/**
 * One query value → its field's shape, or the raw string when it does not
 * decode, so the schema rejects it with a message (never a silent drop). A
 * boolean is "true"/"1" or "false"/"0" — `z.coerce.boolean()` turned the
 * STRING "false" into `true`, the found bug that made `?undated=false` return
 * the undated candidates.
 */
function decodeParam(field: BufferFilterField, raw: string): unknown {
  switch (BUFFER_FILTER_PARAM_CODEC[field]) {
    case "list":
      return splitCsv(raw)
    case "number":
      return raw.trim() === "" ? raw : Number(raw)
    case "boolean":
      if (raw === "true" || raw === "1") return true
      if (raw === "false" || raw === "0") return false
      return raw
    case "text":
      return raw.trim() === "" ? undefined : raw
  }
}

function isBufferFilterField(key: string): key is BufferFilterField {
  return key in BUFFER_FILTER_PARAM_CODEC
}

/**
 * Decode a buffer query string into the canonical filter shape, ready for
 * `bufferFilterSetSchema`. Unknown parameters are left out (the route parses
 * its own, e.g. `limit`).
 */
export function bufferFilterInputFromParams(params: URLSearchParams): Record<string, unknown> {
  const positive: Record<string, unknown> = {}
  const not: Record<string, unknown> = {}
  for (const [key, raw] of params.entries()) {
    const isNot = key.startsWith(NOT_PARAM_PREFIX)
    const field = isNot ? key.slice(NOT_PARAM_PREFIX.length) : key
    if (!isBufferFilterField(field)) continue
    const value = decodeParam(field, raw)
    if (value === undefined) continue
    if (isNot) not[field] = value
    else positive[field] = value
  }
  return Object.keys(not).length > 0 ? { ...positive, not } : positive
}

/** Encode one level of filters into query parameters (inverse of decodeParam). */
function encodeLevel(fields: BufferFilterFields, prefix: string, out: URLSearchParams): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!isBufferFilterField(field) || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length > 0) out.set(prefix + field, value.join(","))
    } else if (typeof value === "string") {
      if (value.trim().length > 0) out.set(prefix + field, value.trim())
    } else {
      out.set(prefix + field, String(value))
    }
  }
}

/** Serialise a filter set into URLSearchParams (lists CSV, `not.<field>`). */
export function bufferFiltersToParams(filters: BufferFilterSet): URLSearchParams {
  const out = new URLSearchParams()
  const { not, ...positive } = filters
  encodeLevel(positive, "", out)
  if (not !== undefined) encodeLevel(not, NOT_PARAM_PREFIX, out)
  return out
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
  arkKind: z.enum(ARK_KIND_VALUES).optional(),
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
