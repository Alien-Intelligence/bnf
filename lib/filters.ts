// lib/filters.ts
// Field schemas shared by the buffer and the corpus filters (agent tools and
// REST alike). Every list is bounded, and every closed dimension is checked
// against its vocabulary, so a typo (`type: ["presse"]`) is refused instead of
// silently matching nothing — or, under `not`, everything. Language is the one
// open dimension (the store holds whatever the BnF records say: `frm`, `mul`,
// `zxx`, …): its bound is the set of languages the buffer or corpus version
// actually holds — what its facets show — checked by the service, which
// refuses any other value with a FilterValueError.
// Pure — zod, constants and the documents vocabulary only.
import { z } from "zod"
import {
  FILTER_LIST_MAX_VALUES,
  LANG_FILTER_MAX_CHARS,
  TEXT_FILTER_MAX_VALUES,
  TEXT_FILTER_MIN_CHARS,
} from "@/lib/constants"
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

/**
 * A filter value the schema could not check alone (it depends on the data —
 * a language the store does not hold). Routes answer 400 (withAuth), agent
 * tools an `invalid_params` refusal.
 */
export class FilterValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FilterValueError"
  }
}

/** The language values a filter set names, positive and inside `not`. */
export function filterLangs(filters: { lang?: string[]; not?: { lang?: string[] } } | undefined): string[] {
  if (filters === undefined) return []
  return [...(filters.lang ?? []), ...(filters.not?.lang ?? [])]
}

/** Throw a FilterValueError naming every requested language the store does not hold. */
export function assertLangsHeld(requested: readonly string[], held: readonly string[], where: string): void {
  const have = new Set(held)
  const missing = [...new Set(requested)].filter((l) => !have.has(l))
  if (missing.length === 0) return
  const shown = held.length > 0 ? held.join(", ") : "aucune"
  throw new FilterValueError(
    `Langue(s) absente(s) ${where} : ${missing.join(", ")}. Langues présentes : ${shown}.`,
  )
}

/** Numérisation / ingestion classes (INGESTION_CLASS). */
export const ingestClassListSchema = codeList(z.enum(INGESTION_CLASS))

/** Indexation outcomes (INDEXATION_OUTCOME). */
export const outcomeListSchema = codeList(z.enum(INDEXATION_OUTCOME))

/** AppSession ids. */
export const sessionIdListSchema = codeList(z.string().uuid())
