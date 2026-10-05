// lib/agent/tools/failure.ts
// The ONE shape of a refused or failed agent tool call: `{ success: false, … }`.
//
// `success: false` is what the chat chip, the flat tool-call mapper and the
// persistence adapter key on (lib/tools/display.ts `toolCallErrored`): a bare
// `{ error }` or a `{ status: "empty_filter" }` passthrough is persisted as
// `status: "ok"` and renders a ✓ for a call that did nothing. A tool never
// throws out of the loop either (CLAUDE_ERROR_PATTERNS §15): it returns one of
// these, and the model reads `error` to recover.
//
// Pure — no server-only import, so the display layer can share the types.
import { REMOVE_BY_FILTER_STATUS } from "@/lib/filters"

/** A tool call that failed or was refused; `error` is model-readable. */
export type ToolFailure = { success: false; error: string }

/** A refusal the UI can name: `refused` is a stable machine-readable reason. */
export type ToolRefusal<R extends string> = ToolFailure & { refused: R }

export function toolFailure(error: string): ToolFailure {
  return { success: false, error }
}

export function toolRefusal<R extends string>(refused: R, error: string): ToolRefusal<R> {
  return { success: false, refused, error }
}

/** `*_remove_by_filter` with no constraint: it would match everything. */
export const EMPTY_FILTER_REFUSAL = REMOVE_BY_FILTER_STATUS.EMPTY_FILTER

/** The turn's user may not perform the action (lib/agent/tools/authorize.ts). */
export const FORBIDDEN_REFUSAL = "forbidden" as const

/** A parameter the tool cannot honour; `problems` says how to fix it. */
export const INVALID_PARAMS_REFUSAL = "invalid_params" as const

/** The BnF declined a query it cannot express on that index (never sent). */
export const QUERY_NOT_EXPRESSIBLE_REFUSAL = "query_not_expressible" as const
