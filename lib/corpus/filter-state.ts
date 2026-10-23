// lib/corpus/filter-state.ts
// The Constituer panel's filter state IS the one corpus filter shape
// (models/corpus/types.ts CorpusFilterSet) — no second, CSV-shaped client
// schema. These helpers edit it immutably; every edit is re-validated by the
// same schema the routes and the agent use, so the panel can never hold a set
// the server would refuse. Pure.
import { corpusFilterSetSchema, type CorpusFilterSet } from "@/models/corpus/types"

/** The multi-select dimensions the panel toggles, named once for every reader. */
export const CORPUS_FILTER_KEY = {
  TYPE: "type",
  SUBTYPE: "subtype",
  LANG: "lang",
  SOURCE: "source",
  SESSION: "session",
  INGEST: "ingest",
  OUTCOME: "outcome",
  KIND: "kind",
} as const
export type CorpusListFilterKey = (typeof CORPUS_FILTER_KEY)[keyof typeof CORPUS_FILTER_KEY]
export const CORPUS_LIST_FILTER_KEYS: readonly CorpusListFilterKey[] = Object.values(CORPUS_FILTER_KEY)

/** A filter edit the corpus filter schema refused (a value off the vocabulary, a list past its bound). */
export class FilterChangeRefusedError extends Error {
  constructor(reason: string) {
    super(`corpus filter change refused: ${reason}`)
    this.name = "FilterChangeRefusedError"
  }
}

/** No filter at all. */
export const EMPTY_CORPUS_FILTERS: CorpusFilterSet = {}

/** The selected values of one multi-select dimension. */
export function selectedValues(filters: CorpusFilterSet, key: CorpusListFilterKey): string[] {
  return [...(filters[key] ?? [])]
}

/**
 * `filters` with `patch` applied, validated by the corpus filter schema.
 * Throws FilterChangeRefusedError when the result would be refused, so the
 * caller can tell the user (see applyFilterChange) instead of the click
 * silently doing nothing.
 */
export function patchFilters(filters: CorpusFilterSet, patch: Record<string, unknown>): CorpusFilterSet {
  const next: Record<string, unknown> = { ...filters, ...patch }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  const parsed = corpusFilterSetSchema.safeParse(next)
  if (parsed.success) return parsed.data
  throw new FilterChangeRefusedError(parsed.error.message)
}

/**
 * Compute a filter edit and hand it to `apply`; a refused edit goes to
 * `onRefused` (the panel's toast) and `apply` is not called. Any other error
 * propagates.
 */
export function applyFilterChange(
  compute: () => CorpusFilterSet,
  apply: (next: CorpusFilterSet) => void,
  onRefused: () => void,
): void {
  let next: CorpusFilterSet
  try {
    next = compute()
  } catch (error) {
    if (error instanceof FilterChangeRefusedError) {
      onRefused()
      return
    }
    throw error
  }
  apply(next)
}

/** Select `value` in `key` when absent, deselect it when present. */
export function toggleFilterValue(filters: CorpusFilterSet, key: CorpusListFilterKey, value: string): CorpusFilterSet {
  const current = selectedValues(filters, key)
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  return patchFilters(filters, { [key]: next.length > 0 ? next : undefined })
}

/** Deselect `value` in `key`. */
export function removeFilterValue(filters: CorpusFilterSet, key: CorpusListFilterKey, value: string): CorpusFilterSet {
  const next = selectedValues(filters, key).filter((v) => v !== value)
  return patchFilters(filters, { [key]: next.length > 0 ? next : undefined })
}

/** True when at least one criterion is set (an exclusion included). */
export function hasActiveFilters(filters: CorpusFilterSet): boolean {
  return (
    CORPUS_LIST_FILTER_KEYS.some((k) => selectedValues(filters, k).length > 0) ||
    (filters.title?.length ?? 0) > 0 ||
    (filters.creator?.length ?? 0) > 0 ||
    filters.yearFrom !== undefined ||
    filters.yearTo !== undefined ||
    filters.undated === true ||
    (filters.q !== undefined && filters.q.length > 0) ||
    filters.not !== undefined
  )
}
