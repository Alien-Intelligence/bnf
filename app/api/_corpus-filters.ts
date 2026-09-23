/**
 * corpusFiltersToFilterSet — the one place the corpus filter wire form becomes
 * the shape the query layer takes.
 *
 * `GET /corpus` and `GET /corpus/export` must agree on what a given query
 * string means: the export exists to hand a librarian exactly the set on
 * screen, so two independent readings of the same params would produce a CSV
 * that quietly disagreed with the panel it came from. Adding a filter dimension
 * is then one edit here rather than one per route.
 *
 * It lives in the API layer, not in models/corpus/types.ts, because the result
 * type belongs to `queries.ts` (server-only) while types.ts is imported by
 * client components — per playbook/models.md, types.ts takes zod and nothing
 * else, and reaching into the query layer from there would put a path to
 * `server-only` code in the client bundle's import graph.
 */
import "server-only"

import type { CorpusFilterSet } from "@/models/corpus/queries"
import type { CorpusFilters } from "@/models/corpus/types"

/**
 * Split a CSV query-string value into a trimmed, non-empty string array.
 * Returns undefined when the value is absent or contains only whitespace, so a
 * malformed parameter reads as "no filter" rather than "match nothing" — the
 * latter would turn a bad query string into an empty corpus.
 */
function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

/**
 * Turn validated query params into a `CorpusFilterSet`, or undefined when no
 * filter is active — the wire form keeps multi-selects as CSV, the query layer
 * wants arrays.
 */
export function corpusFiltersToFilterSet(
  parsed: CorpusFilters,
): CorpusFilterSet | undefined {
  const set: CorpusFilterSet = {
    type: splitCsv(parsed.type),
    lang: splitCsv(parsed.lang),
    source: splitCsv(parsed.source),
    session: splitCsv(parsed.session),
    ingest: splitCsv(parsed.ingest),
    outcome: splitCsv(parsed.outcome),
    yearFrom: parsed.yearFrom,
    yearTo: parsed.yearTo,
    undated: parsed.undated,
    q: parsed.q,
  }
  const active = Object.values(set).some((v) => v !== undefined)
  return active ? set : undefined
}
