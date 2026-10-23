// lib/validation/filter-lists.ts
// Field schemas shared by the buffer and the corpus filters (agent tools and
// REST alike). Every list is bounded, and every closed dimension is checked
// against its vocabulary, so a typo (`type: ["presse"]`) is refused instead of
// silently matching nothing — or, under `not`, everything. Language is the one
// open dimension (the store holds whatever the BnF records say: `frm`, `mul`,
// `zxx`, …): its format is checked here, its VALUE by the service against
// what the buffer or corpus version holds (lib/filters.ts, assertLangsHeld).
// Pure — zod, constants and the documents vocabulary only.
import { z } from "zod"
import {
  FILTER_LIST_MAX_VALUES,
  LANG_FILTER_MAX_CHARS,
  TEXT_FILTER_MAX_VALUES,
  TEXT_FILTER_MIN_CHARS,
} from "@/lib/constants"
import {
  ARK_KIND_VALUES,
  DOC_TYPE_CODE,
  DOCUMENT_SOURCE,
  INDEXATION_OUTCOME,
  INGESTION_CLASS,
  KNOWN_SUBTYPES,
} from "@/models/documents/schema"

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

/** Gallica typedoc subcategories (KNOWN_SUBTYPES): fascicules, titres, estampes, … */
export const subtypeListSchema = codeList(z.enum(KNOWN_SUBTYPES))

/** Record kinds (ARK_KIND). */
export const arkKindListSchema = codeList(z.enum(ARK_KIND_VALUES))

/** Source codes (DOCUMENT_SOURCE). */
export const sourceListSchema = codeList(z.enum(DOCUMENT_SOURCE))

/**
 * Language codes as the store holds them (lowercase, as the language facet
 * shows them: `fr`, `frm`, `mul`). The format is checked here; the VALUE is
 * checked by the service against the languages the buffer or the corpus
 * version actually holds (`{ not: { lang: ["xx"] } }` would otherwise match
 * every row of known language).
 */
export const langListSchema = codeList(
  z
    .string()
    .trim()
    .min(1)
    .max(LANG_FILTER_MAX_CHARS)
    .refine((code) => code === code.toLowerCase(), "code de langue en minuscules, tel que la facette l'affiche"),
)

/** Numérisation / ingestion classes (INGESTION_CLASS). */
export const ingestClassListSchema = codeList(z.enum(INGESTION_CLASS))

/** Indexation outcomes (INDEXATION_OUTCOME). */
export const outcomeListSchema = codeList(z.enum(INDEXATION_OUTCOME))

/** AppSession ids. */
export const sessionIdListSchema = codeList(z.string().uuid())
