// lib/corpus/filter-query.ts
// The corpus filters as a query string — the REST boundary of the ONE corpus
// filter schema (models/corpus/types.ts corpusFilterSetSchema), shared by
// GET /corpus and GET /corpus/export so the export is exactly the set on
// screen. Decoding only reshapes the parameters; the schema validates the
// result, so a bad value is refused with a message, never dropped.
//
// Coded lists (type, lang, source, session, ingest, outcome, kind) accept the
// parameter repeated and/or comma-separated — codes never contain a comma, and
// the Constituer panel sends its multi-selects comma-joined. Free-text lists
// (title, creator) are ONLY repeated, never split, so a value with a comma
// survives. The exclusion travels as `not.<field>`. Pure.
import type { CorpusFilterFields } from "@/models/corpus/types"

/** How each field travels. Keyed by the schema's own keys: a field added to
 *  the schema without a codec is a type error. */
const PARAM_CODEC = {
  type: "codes",
  lang: "codes",
  source: "codes",
  session: "codes",
  ingest: "codes",
  outcome: "codes",
  kind: "codes",
  title: "texts",
  creator: "texts",
  yearFrom: "number",
  yearTo: "number",
  undated: "boolean",
  q: "text",
} as const satisfies Record<keyof CorpusFilterFields, "codes" | "texts" | "number" | "boolean" | "text">

type Field = keyof typeof PARAM_CODEC

const NOT_PREFIX = "not."

function isField(key: string): key is Field {
  return Object.hasOwn(PARAM_CODEC, key)
}

/** The values of one field → its shape, or the raw string when it does not
 *  decode, so the schema rejects it with a message. */
function decode(field: Field, values: string[]): unknown {
  const last = values[values.length - 1]
  switch (PARAM_CODEC[field]) {
    case "codes": {
      const kept = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v.length > 0)
      return kept.length > 0 ? kept : undefined
    }
    case "texts": {
      const kept = values.map((v) => v.trim()).filter((v) => v.length > 0)
      return kept.length > 0 ? kept : undefined
    }
    case "number":
      return last.trim() === "" ? last : Number(last)
    case "boolean":
      // Strict: `z.coerce.boolean()` read the STRING "false" as true.
      if (last === "true" || last === "1") return true
      if (last === "false" || last === "0") return false
      return last
    case "text":
      return last.trim() === "" ? undefined : last
  }
}

/**
 * Decode a corpus query string into the canonical filter shape, ready for
 * `corpusFilterSetSchema`, or undefined when no filter parameter is set (the
 * read is then unfiltered). Other parameters (version, cursor, limit) are left
 * to the route.
 */
export function corpusFilterInputFromParams(params: URLSearchParams): Record<string, unknown> | undefined {
  const positive: Record<string, unknown> = {}
  const not: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) {
    const isNot = key.startsWith(NOT_PREFIX)
    const field = isNot ? key.slice(NOT_PREFIX.length) : key
    if (!isField(field)) continue
    const value = decode(field, params.getAll(key))
    if (value === undefined) continue
    if (isNot) not[field] = value
    else positive[field] = value
  }
  const input = Object.keys(not).length > 0 ? { ...positive, not } : positive
  return Object.keys(input).length > 0 ? input : undefined
}
