// models/buffer/types.ts
// Zod schemas for buffer request validation + their inferred types. What route
// handlers and agent tools validate against, and what client hooks import.
//
// DB-derived shapes (BufferRow, BufferSnapshot) live in schema.ts, not here —
// per playbook/models.md. No imports from other model directories: `arkSchema`
// is redefined here rather than imported from models/corpus (the import diagram
// forbids sideways model imports in types.ts).
import { z } from "zod"
import { arkKindListSchema, docTypeListSchema, langListSchema, sourceListSchema, textAnySchema } from "@/lib/filters"

// ---------------------------------------------------------------------------
// ARK validation (opaque identifier — never constructed, never mutated)
// ---------------------------------------------------------------------------

/** ark:/<NAAN>/<name>, e.g. ark:/12148/bpt6k2839841. */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Buffer filters — ONE definition for the agent tools AND the REST route
// (GET /api/projects/:id/buffer decodes its query string into this shape with
// lib/buffer/filter-query.ts and validates it with this schema; the client
// hook encodes the same shape). Array-based, like the corpus filters.
// ---------------------------------------------------------------------------

/** What a `not` means — the one rule (Decision 4), said the same everywhere. */
export const NOT_FILTER_RULE =
  "EXCLUDE candidates matching ALL these criteria. A candidate whose value is UNKNOWN for a " +
  "criterion used here is never matched by `not`: it is neither listed nor removed, and every " +
  "read and dry run reports how many such candidates were left out, per criterion, as `notUnknown`."

export const bufferFilterFieldsSchema = z.object({
  type: docTypeListSchema
    .optional()
    .describe(
      "Canonical doc-type codes to match: book | press | image | map | manuscript | score | " +
        "audio | video | object | poster | estampe | enlum | charte | other | text (« texte " +
        'imprimé, nature indéterminée »), e.g. ["press","book"].',
    ),
  kind: arkKindListSchema
    .optional()
    .describe(
      "Record kinds to match: periodical_issue | periodical_collection | monograph | image | " +
        "catalogue_notice | other_document | unknown.",
    ),
  lang: langListSchema.optional().describe('Language codes to match (ISO 639, lowercase: ["fr","la","de"]).'),
  source: sourceListSchema.optional().describe('Sources to match: "gallica" | "catalogue" | "databnf" | "other".'),
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
      "true: candidates WITHOUT their metadata — still being resolved in the background, or given " +
        "up on (filters on title/type/date cannot see them; this is the `unresolved` count every " +
        "buffer read returns); false: only candidates with their metadata.",
    ),
  q: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text match over title, creator, snippet and subjects."),
})

export const bufferFilterSetSchema = bufferFilterFieldsSchema
  .extend({ not: bufferFilterFieldsSchema.optional().describe(NOT_FILTER_RULE) })
  .describe("Metadata filters over the buffer candidates, to MATCH. Omit a field to leave it unconstrained.")

/** One level of buffer filter criteria (OR within a dimension, AND across). */
export type BufferFilterFields = z.infer<typeof bufferFilterFieldsSchema>
/** The buffer filter set: the criteria, plus a one-level `not`. */
export type BufferFilterSet = z.infer<typeof bufferFilterSetSchema>

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
  arkKind: arkKindListSchema.element.optional(),
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
