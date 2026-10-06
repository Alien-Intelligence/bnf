// lib/corpus/filter-query.ts
// The corpus filter fields as a query string: the field list of the shared
// codec (lib/filter-query.ts) for the ONE corpus filter schema
// (models/corpus/types.ts corpusFilterSetSchema), shared by GET /corpus,
// GET /corpus/export and the Constituer page, so the export is exactly the set
// on screen. Keyed by the schema's own keys. Pure.
import { createFilterQueryCodec } from "@/lib/filter-query"
import type { CorpusFilterFields } from "@/models/corpus/types"

const CORPUS_FILTER_FIELDS = {
  type: "codes",
  lang: "codes",
  source: "codes",
  session: "codes",
  ingest: "codes",
  outcome: "codes",
  kind: "codes",
  title: "texts",
  creator: "texts",
  yearFrom: "integer",
  yearTo: "integer",
  undated: "boolean",
  q: "text",
} as const satisfies Record<keyof CorpusFilterFields, "codes" | "texts" | "integer" | "boolean" | "text">

type CorpusFilterField = keyof typeof CORPUS_FILTER_FIELDS

/** `session` is a UI attribution facet: it never appears inside `not`. */
const NOT_FIELDS = Object.keys(CORPUS_FILTER_FIELDS).filter(
  (k): k is CorpusFilterField => Object.hasOwn(CORPUS_FILTER_FIELDS, k) && k !== "session",
)

export const corpusFilterQuery = createFilterQueryCodec<CorpusFilterField>(CORPUS_FILTER_FIELDS, NOT_FIELDS)
