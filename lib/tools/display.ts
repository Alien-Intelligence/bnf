// lib/tools/display.ts
// Pure, client-safe helpers for rendering agent tool calls in the chat panel.
// No server imports — used by the chat tool renderers (components/badges/tools).
import { CORPUS_EVENT_KIND, type CorpusEventKind } from "@/lib/agent/stream-event-types"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { EMPTY_FILTER_REFUSAL } from "@/lib/agent/tools/failure"
import { REMOVE_BY_FILTER_STATUS } from "@/lib/filters"

/** Whether a tool name is an MCP tool (server-prefixed: "bnf__bnf_search…"). */
export function toolSource(toolName: string): "custom" | "mcp" {
  return toolName.includes("__") ? "mcp" : "custom"
}

/**
 * Derive the dotted i18n / display key from a raw tool name.
 *
 * MCP:    "bnf__bnf_search_gallica" → "bnf.search_gallica"
 * Custom: "corpus_add"             → "corpus.add"
 *         "corpus_get_state"       → "corpus.get_state" (only first "_" → ".")
 *
 * The key doubles as the i18n lookup (in the "tools" namespace) and the
 * mono display label shown in the search block.
 */
export function deriveToolKey(
  toolName: string,
  source: "custom" | "mcp" = toolSource(toolName),
): string {
  if (source === "mcp") {
    const mcpMatch = /^(\w+)__\1_(.+)$/.exec(toolName)
    if (mcpMatch) {
      const [, server, suffix] = mcpMatch
      return `${server}.${suffix}`
    }
    const bare = toolName.replace(/^[^_]+__/, "")
    const sep = bare.indexOf("_")
    return sep === -1 ? bare : bare.slice(0, sep) + "." + bare.slice(sep + 1)
  }
  const i = toolName.indexOf("_")
  if (i === -1) return toolName
  return toolName.slice(0, i) + "." + toolName.slice(i + 1)
}

/** True for the corpus mutation tools that render as a +N / −N pill. */
export function isCorpusMutationTool(toolName: string): CorpusEventKind | null {
  if (toolName === AGENT_TOOLS.corpusAdd) return CORPUS_EVENT_KIND.ADD
  if (toolName === AGENT_TOOLS.corpusRemove) return CORPUS_EVENT_KIND.REMOVE
  return null
}

/** How a note-writing tool writes its note. */
export const NOTE_WRITE_KIND = { CREATE: "create", UPDATE: "update", APPEND: "append" } as const
export type NoteWriteKind = (typeof NOTE_WRITE_KIND)[keyof typeof NOTE_WRITE_KIND]

/**
 * True for the note-writing tools whose input IS the artifact — the whole note
 * body streams in as the tool input, so while running they get a live progress
 * view (char count + elapsed) instead of a motionless "running" badge.
 */
export function isNoteWriteTool(toolName: string): NoteWriteKind | null {
  if (toolName === AGENT_TOOLS.noteCreate) return NOTE_WRITE_KIND.CREATE
  if (toolName === AGENT_TOOLS.noteUpdate) return NOTE_WRITE_KIND.UPDATE
  if (toolName === AGENT_TOOLS.noteAppend) return NOTE_WRITE_KIND.APPEND
  return null
}

/** Safely JSON-parse a tool result string; returns null on any failure. */
function parseResult(result: string): unknown {
  if (!result) return null
  try {
    return JSON.parse(result)
  } catch {
    return null
  }
}

/**
 * Coerce a value to an object scope for field lookup. Tool results nest the
 * payload under `content`/`data`, and that nested value is sometimes an object
 * and sometimes a stringified JSON blob (the persistence layer stores
 * `{ content: "<json>" }`), so a string scope is re-parsed.
 */
function asScope(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const reparsed = parseResult(value)
    return reparsed && typeof reparsed === "object"
      ? (reparsed as Record<string, unknown>)
      : null
  }
  if (value && typeof value === "object") return value as Record<string, unknown>
  return null
}

/**
 * Recursively pull the BnF-MCP envelope object out of a tool result, walking
 * the shapes a result can arrive in: a JSON string, the persisted
 * `{ content: "<json>" }` wrapper, and an MCP `[{ type:"text", text }]`
 * content-block array. Returns the first object that carries a `success` flag,
 * or null. Depth-bounded to stay cheap and avoid pathological nesting.
 */
function extractEnvelope(
  value: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (depth > 4 || value == null) return null
  if (typeof value === "string") {
    const parsed = parseResult(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  }
  if (Array.isArray(value)) {
    // MCP content-block array — the envelope JSON lives in a text block.
    for (const block of value) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const env = extractEnvelope((block as Record<string, unknown>).text, depth + 1)
        if (env && "success" in env) return env
      }
    }
    return null
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    if ("success" in obj) return obj
    // Unwrap the persisted / MCP `{ content: <envelope|string|blocks> }` form.
    if ("content" in obj) return extractEnvelope(obj.content, depth + 1)
    return null
  }
  return null
}

/**
 * Detect a BnF-MCP "soft failure": the MCP relays an upstream HTTP failure
 * (Gallica 403/429/500…) as a SUCCESSFUL MCP call — transport 200, the
 * CallToolResult `isError` flag unset — whose body is the BnF MCP's documented
 * failure envelope `{ success: false, status_code, error }`. Without this, such
 * a call records as "ok": the chip shows ✓ and the health indicator stays green
 * despite a real failure.
 *
 * Returns true ONLY on an explicit `success === false`; it never guesses from
 * free text, so a legitimate result that merely mentions an error is unaffected.
 */
export function mcpResultFailed(result: unknown): boolean {
  return extractEnvelope(result, 0)?.success === false
}

/**
 * Whether a settled tool call should count as an ERROR for status display and
 * health aggregation: the SDK transport-level `isError`, OR a BnF-MCP soft
 * failure the transport reported as success. Shared by the chat chip
 * (components/layouts/corpus/chat.tsx), the flat tool-call mapper
 * (hooks/api/turn-stream.ts), and the persistence adapter
 * (lib/agent/persistence/prisma-adapter.ts) so all three agree byte-for-byte.
 */
export function toolCallErrored(sdkIsError: boolean, result: unknown): boolean {
  return sdkIsError || mcpResultFailed(result)
}

/**
 * Pull an integer field out of a tool result JSON, trying several keys.
 * The BnF MCP wraps payloads in `{ success, data }`, so we look inside `data`
 * too. Returns null when no numeric field is found.
 */
function pickNumber(result: string, keys: string[]): number | null {
  const parsed = parseResult(result)
  if (parsed === null || typeof parsed !== "object") return null
  // Tool results may be flat, or wrapped: the persistence layer stores
  // `{ content: "<json>" }` (content is a JSON string) and the BnF MCP wraps in
  // `{ success, data }`. Check the top level and both (possibly re-parsed) scopes.
  const obj = parsed as Record<string, unknown>
  const scopes: Record<string, unknown>[] = [obj]
  for (const wrapper of ["content", "data"]) {
    const inner = asScope(obj[wrapper])
    if (inner) scopes.push(inner)
  }
  for (const scope of scopes) {
    for (const key of keys) {
      const v = scope[key]
      if (typeof v === "number" && Number.isFinite(v)) return v
    }
  }
  return null
}

/** Pull a string field out of a tool result JSON, trying several keys. */
function pickString(result: string, keys: string[]): string | null {
  const parsed = parseResult(result)
  if (parsed === null || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const scopes: Record<string, unknown>[] = [obj]
  for (const wrapper of ["content", "data"]) {
    const inner = asScope(obj[wrapper])
    if (inner) scopes.push(inner)
  }
  for (const scope of scopes) {
    for (const key of keys) {
      const v = scope[key]
      if (typeof v === "string" && v.length > 0) return v
    }
  }
  return null
}

/** True for the bulk remove-by-filter tool (rendered as a dedicated pill). */
export function isCorpusRemoveByFilterTool(toolName: string): boolean {
  return toolName === AGENT_TOOLS.corpusRemoveByFilter
}

/**
 * The settled outcome of a corpus_remove_by_filter call, parsed from its result
 * JSON: the tool's empty-filter refusal, or a `CorpusRemoveByFilterResult`
 * outcome (models/corpus/service.ts). Returns
 * null while the result is not yet available (still running) or unparseable —
 * the pill then shows its running/neutral state.
 */
export type RemoveByFilterView =
  | { status: typeof REMOVE_BY_FILTER_STATUS.EMPTY_FILTER }
  | { status: typeof REMOVE_BY_FILTER_STATUS.DRY_RUN; matched: number }
  | { status: typeof REMOVE_BY_FILTER_STATUS.REMOVED; removed: number; matched: number }
  | null

export function corpusRemoveByFilterView(result: string): RemoveByFilterView {
  // The refusal is a `{ success: false, refused: "empty_filter" }` tool failure
  // (lib/agent/tools/failure.ts); the outcomes carry `status`.
  if (pickString(result, ["refused"]) === EMPTY_FILTER_REFUSAL) return { status: REMOVE_BY_FILTER_STATUS.EMPTY_FILTER }
  const status = pickString(result, ["status"])
  if (status === REMOVE_BY_FILTER_STATUS.DRY_RUN) {
    return { status: REMOVE_BY_FILTER_STATUS.DRY_RUN, matched: pickNumber(result, ["matched"]) ?? 0 }
  }
  if (status === REMOVE_BY_FILTER_STATUS.REMOVED) {
    return {
      status: REMOVE_BY_FILTER_STATUS.REMOVED,
      removed: pickNumber(result, ["removed"]) ?? 0,
      matched: pickNumber(result, ["matched"]) ?? 0,
    }
  }
  return null
}

/** Number of documents a corpus mutation actually changed (post-dedup). */
export function mutationCount(result: string): number | null {
  return pickNumber(result, ["added", "removed"])
}

/** Supplied ARKs skipped by corpus_add (already present or repeated). */
export function mutationDuplicates(result: string): number | null {
  return pickNumber(result, ["duplicates"])
}
