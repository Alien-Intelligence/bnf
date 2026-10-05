// lib/buffer/filter-query.ts
// The buffer filters as a query string — the REST/UI boundary of the ONE
// filter schema (models/buffer/types.ts bufferFilterSetSchema). Decoding only
// reshapes the parameters; the schema validates the result, so a bad value is
// refused with a message, never dropped.
//
// A free-text list (title, creator, subject) travels as the parameter
// REPEATED (`creator=Hugo, Victor&creator=Zola`), never split, so a value
// containing a comma survives the round trip. A coded list (type, kind, lang,
// source) accepts it repeated and/or comma-separated — codes never contain a
// comma (the same rule as lib/corpus/filter-query.ts). The exclusion travels
// as `not.<field>`. Pure.
import type { BufferFilterFields, BufferFilterSet } from "@/models/buffer/types"

/** How each field travels. Keyed by the schema's own keys: a field added to
 *  the schema without a codec is a type error. */
const PARAM_CODEC = {
  type: "codes",
  kind: "codes",
  lang: "codes",
  source: "codes",
  title: "texts",
  creator: "texts",
  subject: "texts",
  yearFrom: "number",
  yearTo: "number",
  undated: "boolean",
  unresolved: "boolean",
  q: "text",
} as const satisfies Record<keyof BufferFilterFields, "codes" | "texts" | "number" | "boolean" | "text">

type Field = keyof typeof PARAM_CODEC

/** The exclusion's fields travel as `not.<field>`. */
const NOT_PREFIX = "not."

function isField(key: string): key is Field {
  return Object.hasOwn(PARAM_CODEC, key)
}

/**
 * The values of one field → its shape, or the raw string when it does not
 * decode, so the schema rejects it with a message. A boolean is "true"/"1" or
 * "false"/"0" — `z.coerce.boolean()` turned the STRING "false" into `true`,
 * the found bug that made `?undated=false` return the undated candidates.
 */
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
      if (last === "true" || last === "1") return true
      if (last === "false" || last === "0") return false
      return last
    case "text":
      return last.trim() === "" ? undefined : last
  }
}

/**
 * Decode a buffer query string into the canonical filter shape, ready for
 * `bufferFilterSetSchema`. Unknown parameters are left out (the route parses
 * its own, e.g. `limit`).
 */
export function bufferFilterInputFromParams(params: URLSearchParams): Record<string, unknown> {
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
  return Object.keys(not).length > 0 ? { ...positive, not } : positive
}

function encodeLevel(fields: BufferFilterFields, prefix: string, out: URLSearchParams): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!isField(field) || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) out.append(prefix + field, String(item))
    } else if (typeof value === "string") {
      if (value.trim().length > 0) out.set(prefix + field, value.trim())
    } else {
      out.set(prefix + field, String(value))
    }
  }
}

/** Serialise a filter set into URLSearchParams — the exact inverse of
 *  bufferFilterInputFromParams. */
export function bufferFiltersToParams(filters: BufferFilterSet): URLSearchParams {
  const out = new URLSearchParams()
  const { not, ...positive } = filters
  encodeLevel(positive, "", out)
  if (not !== undefined) encodeLevel(not, NOT_PREFIX, out)
  return out
}
