// lib/buffer/filter-query.ts
// The buffer filter fields as a query string: the field list of the shared
// codec (lib/filter-query.ts) for the ONE buffer filter schema
// (models/buffer/types.ts bufferFilterSetSchema). Keyed by the schema's own
// keys, so a field added to the schema without a codec is a type error. Pure.
import { createFilterQueryCodec } from "@/lib/filter-query"
import type { BufferFilterFields } from "@/models/buffer/types"

const BUFFER_FILTER_FIELDS = {
  type: "codes",
  kind: "codes",
  lang: "codes",
  source: "codes",
  title: "texts",
  creator: "texts",
  subject: "texts",
  yearFrom: "integer",
  yearTo: "integer",
  undated: "boolean",
  unresolved: "boolean",
  q: "text",
} as const satisfies Record<keyof BufferFilterFields, "codes" | "texts" | "integer" | "boolean" | "text">

type BufferFilterField = keyof typeof BUFFER_FILTER_FIELDS

const FIELDS = Object.keys(BUFFER_FILTER_FIELDS).filter((k): k is BufferFilterField =>
  Object.hasOwn(BUFFER_FILTER_FIELDS, k),
)

/** Every buffer field may also be excluded (`not.<field>`). */
export const bufferFilterQuery = createFilterQueryCodec<BufferFilterField>(BUFFER_FILTER_FIELDS, FIELDS)
