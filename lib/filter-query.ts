// lib/filter-query.ts
// A filter set as a query string — the REST/UI boundary of a filter schema,
// ONE implementation parameterised by the field list (the buffer and the
// corpus each declare theirs: lib/buffer/filter-query.ts,
// lib/corpus/filter-query.ts).
//
// Decoding only reshapes the parameters; the schema validates the result, so a
// bad value is refused with a message, never dropped. An UNKNOWN parameter is
// refused too (`langs`, `not.session`, `not.not.type`): silently dropping it
// would widen a removal — `{ session, lang }` read as `{ lang }` removes every
// matching document of every session. A route names its own parameters
// (`limit`, `cursor`, `version`, …) so they are not taken for filters.
//
// How each field travels:
//   - codes: repeated and/or comma-separated — codes never contain a comma
//     (the Constituer panel sends its multi-selects comma-joined);
//   - texts: REPEATED only, never split, so a value with a comma survives;
//   - integer: digits only, an optional leading minus (`0x10`, `1e3`, `12.5`
//     are refused, not read as 16 / 1000 / 12);
//   - boolean: "true"/"1" or "false"/"0" (`z.coerce.boolean()` read the STRING
//     "false" as true — the found bug behind `?undated=false`);
//   - text: one value.
// The exclusion travels as `not.<field>`, one level deep. Pure.

export type FilterFieldCodec = "codes" | "texts" | "integer" | "boolean" | "text"

/** The exclusion's fields travel as `not.<field>`. */
export const NOT_PARAM_PREFIX = "not."

const INTEGER = /^-?\d+$/

export type FilterQueryDecode =
  | { ok: true; input: Record<string, unknown> | undefined }
  | { ok: false; error: string }

export interface FilterQueryCodec<F extends string> {
  /** Decode `params` into the filter shape the schema validates (undefined when
   *  no filter is set); refuses a parameter that is neither a filter field nor
   *  one of `routeParams`. */
  decode(params: URLSearchParams, routeParams?: readonly string[]): FilterQueryDecode
  /** The exact inverse of `decode` for a valid filter set. */
  encode(filters: FilterSetShape<F>): URLSearchParams
}

/** What `encode` accepts: the fields, and a one-level `not`. */
export type FilterSetShape<F extends string> = Partial<Record<F, unknown>> & {
  not?: Partial<Record<F, unknown>>
}

export function createFilterQueryCodec<F extends string>(
  fields: Readonly<Record<F, FilterFieldCodec>>,
  notFields: readonly F[],
): FilterQueryCodec<F> {
  const isField = (key: string): key is F => Object.hasOwn(fields, key)
  const allowedInNot = new Set<string>(notFields)

  /** The values of one field → its shape, or the raw string when it does not
   *  decode, so the schema rejects it with a message. */
  const decodeField = (field: F, values: string[]): unknown => {
    const last = values[values.length - 1]
    switch (fields[field]) {
      case "codes": {
        const kept = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v.length > 0)
        return kept.length > 0 ? kept : undefined
      }
      case "texts": {
        const kept = values.map((v) => v.trim()).filter((v) => v.length > 0)
        return kept.length > 0 ? kept : undefined
      }
      case "integer":
        return INTEGER.test(last.trim()) ? Number(last.trim()) : last
      case "boolean":
        if (last === "true" || last === "1") return true
        if (last === "false" || last === "0") return false
        return last
      case "text":
        return last.trim() === "" ? undefined : last
    }
  }

  const known = (): string =>
    [...Object.keys(fields), ...notFields.map((f) => NOT_PARAM_PREFIX + f)].join(", ")

  const encodeLevel = (level: object, prefix: string, out: URLSearchParams): void => {
    for (const [field, value] of Object.entries(level)) {
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

  return {
    decode(params, routeParams = []) {
      const route = new Set(routeParams)
      const positive: Record<string, unknown> = {}
      const not: Record<string, unknown> = {}
      for (const key of new Set(params.keys())) {
        if (route.has(key)) continue
        const isNot = key.startsWith(NOT_PARAM_PREFIX)
        const field = isNot ? key.slice(NOT_PARAM_PREFIX.length) : key
        if (!isField(field) || (isNot && !allowedInNot.has(field))) {
          return { ok: false, error: `Paramètre de filtre inconnu : « ${key} ». Paramètres reconnus : ${known()}.` }
        }
        const value = decodeField(field, params.getAll(key))
        if (value === undefined) continue
        if (isNot) not[field] = value
        else positive[field] = value
      }
      const input = Object.keys(not).length > 0 ? { ...positive, not } : positive
      return { ok: true, input: Object.keys(input).length > 0 ? input : undefined }
    },
    encode(filters) {
      const out = new URLSearchParams()
      const { not, ...positive } = filters
      encodeLevel(positive, "", out)
      if (not !== undefined) encodeLevel(not, NOT_PARAM_PREFIX, out)
      return out
    },
  }
}

/** The outcome of reading a filter set from a query string. */
export type FilterParamsResult<T> =
  | { ok: true; filters: T | undefined }
  | { ok: false; error: string; issues?: ReadonlyArray<{ path: PropertyKey[]; message: string }> }

/**
 * Decode `params` with `codec` and validate with `schema` — the ONE way a
 * filter set is read from a URL, on the server (REST routes: a 400) and on the
 * client (the Constituer page: an empty filter and a visible notice, never a
 * thrown render).
 */
export function parseFilterParams<F extends string, T>(
  codec: FilterQueryCodec<F>,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } },
  params: URLSearchParams,
  routeParams: readonly string[] = [],
): FilterParamsResult<T> {
  const decoded = codec.decode(params, routeParams)
  if (!decoded.ok) return { ok: false, error: decoded.error }
  if (decoded.input === undefined) return { ok: true, filters: undefined }
  const parsed = schema.safeParse(decoded.input)
  if (parsed.success) return { ok: true, filters: parsed.data }
  const detail = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "filtres"} : ${i.message}`).join(" ; ")
  return { ok: false, error: `Filtres invalides — ${detail}`, issues: parsed.error.issues }
}
