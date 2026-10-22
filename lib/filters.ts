// lib/filters.ts
// What the buffer and corpus filter services share beyond the field schemas
// (lib/validation/filter-lists.ts): the `remove_by_filter` status codes and the
// language-VALUE check — the store's languages are open, so the schema checks
// only the format and the service refuses any language the buffer or corpus
// version does not hold with a FilterValueError.
// Pure — no imports.

/** What a `*_remove_by_filter` call did — buffer and corpus alike. */
export const REMOVE_BY_FILTER_STATUS = {
  /** No constraint: it would match everything, so it was refused unmutated. */
  EMPTY_FILTER: "empty_filter",
  /** A preview: nothing removed. */
  DRY_RUN: "dry_run",
  /** The removal committed. */
  REMOVED: "removed",
} as const

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
