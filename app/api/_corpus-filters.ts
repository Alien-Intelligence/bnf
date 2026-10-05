/**
 * parseCorpusFilters — the one place a corpus request's filters are read.
 *
 * `GET /corpus` and `GET /corpus/export` must agree on what a given query
 * string means: the export exists to hand a librarian exactly the set on
 * screen. Both read it with the shared codec and the ONE corpus filter schema
 * the agent tools and the Constituer page also use (lib/filter-query.ts
 * parseFilterParams, lib/corpus/filter-query.ts, models/corpus/types.ts
 * corpusFilterSetSchema). A parameter that is neither a filter nor one of the
 * route's own is refused, never dropped.
 */
import "server-only"

import { badRequest } from "@/lib/api-response"
import { corpusFilterQuery } from "@/lib/corpus/filter-query"
import { parseFilterParams } from "@/lib/filter-query"
import { corpusFilterSetSchema, type CorpusFilterSet } from "@/models/corpus/types"

/** The request's corpus filters, undefined when none is set, or a 400 naming what is wrong. */
export function parseCorpusFilters(req: Request, routeParams: readonly string[]): CorpusFilterSet | undefined | Response {
  const read = parseFilterParams(corpusFilterQuery, corpusFilterSetSchema, new URL(req.url).searchParams, routeParams)
  return read.ok ? read.filters : badRequest(read.error, read.issues)
}
