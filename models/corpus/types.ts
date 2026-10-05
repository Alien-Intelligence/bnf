// models/corpus/types.ts
// Zod schemas for corpus API request validation and their inferred types.
// These are what route handlers validate against and what client hooks import.
//
// DB-derived shapes (CorpusSnapshot, DocumentRow, CorpusDiff) live in
// schema.ts, not here — per playbook/models.md.

import { z } from "zod"
import {
  arkKindListSchema,
  docTypeListSchema,
  ingestClassListSchema,
  langListSchema,
  outcomeListSchema,
  sessionIdListSchema,
  sourceListSchema,
  textAnySchema,
} from "@/lib/filters"

// ---------------------------------------------------------------------------
// Corpus filters — ONE definition for the agent tools AND the REST routes
// (GET /corpus and /corpus/export decode their query string into this shape
// with lib/corpus/filter-query.ts and validate it with this schema).
//
// Found bug: every description used to say "to KEEP", while
// corpus_remove_by_filter removes what MATCHES — an agent in prod reasoned
// "the 'to keep' description is a copy-paste error" mid-turn. Every criterion
// now says what it matches; the tools say what they do with the match.
// ---------------------------------------------------------------------------

export const corpusFilterFieldsSchema = z.object({
  type: docTypeListSchema.optional().describe('Doc-type codes to match, e.g. ["book","press"].'),
  lang: langListSchema.optional().describe('Language codes to match (ISO 639, lowercase), e.g. ["fr","la","de"].'),
  source: sourceListSchema.optional().describe('Sources to match: "gallica" | "catalogue" | "databnf" | "other".'),
  session: sessionIdListSchema
    .optional()
    .describe("Sessions (ids) whose contributions to keep — the panel's attribution facet."),
  title: textAnySchema
    .optional()
    .describe(
      "Contains ANY of these strings in the title (case-insensitive, accent-sensitive — pass " +
        'variants: ["Algérie","Algerie"]).',
    ),
  creator: textAnySchema
    .optional()
    .describe("Contains ANY of these strings in the author (case-insensitive, accent-sensitive)."),
  kind: arkKindListSchema
    .optional()
    .describe(
      "Record kinds to match: periodical_issue | periodical_collection | monograph | image | " +
        "catalogue_notice | other_document | unknown.",
    ),
  ingest: ingestClassListSchema
    .optional()
    .describe("Numérisation classes to match: ocr | vision | sans_texte | non_numerise."),
  outcome: outcomeListSchema
    .optional()
    .describe(
      "Indexation outcome to match — what became of the document when the " +
        "corpus was last ingested. `indexed`: in the search index, you can " +
        "retrieve it. `failed`: sent for indexing and broke (throttling, bad " +
        "transcription); it is IN the corpus but NOT searchable. `excluded`: " +
        "never sent because it has no text to index (a catalogue notice, an " +
        "undigitized work). `not_ingested`: added since the last ingestion. " +
        "Use this when a search over the corpus returns less than the corpus " +
        "visibly contains: documents that are not `indexed` exist but cannot " +
        "be found by rag_* tools, and saying they are absent would be wrong. " +
        "This describes the past, not a judgement — never use it to decide " +
        "which documents belong in a corpus.",
    ),
  yearFrom: z
    .number()
    .int()
    .optional()
    .describe("Year lower bound, inclusive (e.g. 1970)."),
  yearTo: z
    .number()
    .int()
    .optional()
    .describe("Year upper bound, inclusive (e.g. 2025)."),
  undated: z
    .boolean()
    .optional()
    .describe("Match only documents with an unknown date. Ignored when yearFrom/yearTo is set."),
  q: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text match over title, author, and excerpt."),
})

export const corpusFilterSetSchema = corpusFilterFieldsSchema
  .extend({
    not: corpusFilterFieldsSchema
      .omit({ session: true })
      .optional()
      .describe(
        "EXCLUDE documents matching ALL these criteria. A document whose value is UNKNOWN for a " +
          "criterion used here is never matched by `not`: it is neither listed nor removed, and " +
          "every read and dry run reports how many such documents were left out, per criterion, " +
          "as `notUnknown`.",
      ),
  })
  .describe(
    "Metadata filters, to MATCH. In corpus_remove_by_filter, documents MATCHING the filter are " +
      "removed; in the read tools they are kept in view. Omit a field to leave that dimension " +
      "unconstrained.",
  )

/** One level of corpus filter criteria (OR within a dimension, AND across). */
export type CorpusFilterFields = z.infer<typeof corpusFilterFieldsSchema>
/** The corpus filter set: the criteria plus a one-level `not` (no `session` inside). */
export type CorpusFilterSet = z.infer<typeof corpusFilterSetSchema>
/** The fields a corpus `not` may carry. */
export type CorpusNotFilterSet = NonNullable<CorpusFilterSet["not"]>

/** The agent's filter schema: the same definition, minus the UI-only session facet. */
export const corpusAgentFilterSetSchema = corpusFilterSetSchema.omit({ session: true })


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
  /**
   * Comma-separated indexation outcomes:
   * "indexed" | "failed" | "excluded" | "not_ingested". What BECAME of the
   * document at ingestion — the outcome, not the pre-flight `ingest` class.
   * Derived from indexedAt/indexError; see classifyOutcome().
   */
  outcome: z.string().optional(),
  /** Decade start (inclusive), e.g. 1880 */
  yearFrom: z.coerce.number().int().optional(),
  /** Decade end (inclusive), e.g. 1889 */
  yearTo: z.coerce.number().int().optional(),
  /** "true"/"1" or "false"/"0" — `z.coerce.boolean()` read the STRING "false" as true. */
  undated: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .optional(),
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
  if (filters.outcome) p.set("outcome", filters.outcome)
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
  key: "type" | "lang" | "source" | "session" | "ingest" | "outcome",
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
    (!!filters.outcome && filters.outcome.length > 0) ||
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

/**
 * Re-queue background metadata resolution for one or more documents (the detail
 * panel's "retry" affordance + its auto-retry on first paint). Capped low: this
 * is a per-document user action, not a bulk import.
 */
export const retryResolveSchema = z.object({
  arks: z.array(arkSchema).min(1).max(50),
})

export type RetryResolveInput = z.infer<typeof retryResolveSchema>

/**
 * Promote a single catalogue notice (`cb…`) to its digitized Gallica document
 * on demand. One ARK per call — it is a per-notice action from the detail panel.
 */
export const promoteNoticeSchema = z.object({
  ark: arkSchema,
})

export type PromoteNoticeInput = z.infer<typeof promoteNoticeSchema>

// ---------------------------------------------------------------------------
// Diff query params
// ---------------------------------------------------------------------------

export const corpusDiffQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
})

export type CorpusDiffQuery = z.infer<typeof corpusDiffQuerySchema>
