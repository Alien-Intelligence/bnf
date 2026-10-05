// lib/filters.ts
// Field schemas shared by the buffer and the corpus filters (agent tools and
// REST alike). Every list is bounded, and every coded dimension is checked
// against its vocabulary, so a typo (`type: ["presse"]`) is refused instead of
// silently matching nothing — or, under `not`, everything.
// Pure — zod, constants and the documents vocabulary only.
import { z } from "zod"
import { FILTER_LIST_MAX_VALUES, TEXT_FILTER_MAX_VALUES, TEXT_FILTER_MIN_CHARS } from "@/lib/constants"
import { canonicalLang } from "@/lib/mcp/vocab"
import { ARK_KIND_VALUES, DOC_TYPE_CODE, DOCUMENT_SOURCE, INDEXATION_OUTCOME, INGESTION_CLASS } from "@/models/documents/schema"

/** What a `*_remove_by_filter` call did — buffer and corpus alike. */
export const REMOVE_BY_FILTER_STATUS = {
  /** No constraint: it would match everything, so it was refused unmutated. */
  EMPTY_FILTER: "empty_filter",
  /** A preview: nothing removed. */
  DRY_RUN: "dry_run",
  /** The removal committed. */
  REMOVED: "removed",
} as const

/** Text criteria: contains-ANY, case-insensitive, accent-sensitive. */
export const textAnySchema = z
  .array(z.string().trim().min(TEXT_FILTER_MIN_CHARS))
  .min(1)
  .max(TEXT_FILTER_MAX_VALUES)

/** A bounded, non-empty list of one coded value. */
function codeList<T extends z.ZodType>(code: T) {
  return z.array(code).min(1).max(FILTER_LIST_MAX_VALUES)
}

/** Canonical docType codes (DOC_TYPE_CODE). */
export const docTypeListSchema = codeList(z.enum(DOC_TYPE_CODE))

/** Record kinds (ARK_KIND). */
export const arkKindListSchema = codeList(z.enum(ARK_KIND_VALUES))

/** Source codes (DOCUMENT_SOURCE). */
export const sourceListSchema = codeList(z.enum(DOCUMENT_SOURCE))

/**
 * Language codes in the stored form: exactly what canonicalLang (the
 * normaliser) writes — `de`, never `ger`, `DEU` or `allemand` — so a filter
 * value can only be one a row can carry.
 */
export const langListSchema = codeList(
  z
    .string()
    .regex(/^[a-z]{2,3}$/, "code de langue ISO 639 en minuscules (ex. fr, de, la)")
    .refine((code) => canonicalLang(code) === code, "code de langue non canonique"),
)

/** Numérisation / ingestion classes (INGESTION_CLASS). */
export const ingestClassListSchema = codeList(z.enum(INGESTION_CLASS))

/** Indexation outcomes (INDEXATION_OUTCOME). */
export const outcomeListSchema = codeList(z.enum(INDEXATION_OUTCOME))

/** AppSession ids. */
export const sessionIdListSchema = codeList(z.string().uuid())
