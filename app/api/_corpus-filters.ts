/**
 * parseCorpusFilters — the one place a corpus request's filters are read.
 *
 * `GET /corpus` and `GET /corpus/export` must agree on what a given query
 * string means: the export exists to hand a librarian exactly the set on
 * screen. Both decode the query string with lib/corpus/filter-query.ts and
 * validate it with the ONE corpus filter schema the agent tools also use
 * (models/corpus/types.ts corpusFilterSetSchema).
 */
import "server-only"

import { badRequest } from "@/lib/api-response"
import { corpusFilterInputFromParams } from "@/lib/corpus/filter-query"
import { corpusFilterSetSchema, type CorpusFilterSet } from "@/models/corpus/types"

/** The request's corpus filters, undefined when none is set, or a 400 naming what is wrong. */
export function parseCorpusFilters(req: Request): CorpusFilterSet | undefined | Response {
  const input = corpusFilterInputFromParams(new URL(req.url).searchParams)
  if (input === undefined) return undefined
  const parsed = corpusFilterSetSchema.safeParse(input)
  return parsed.success ? parsed.data : badRequest("Invalid corpus filters", parsed.error.issues)
}
