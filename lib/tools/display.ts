// lib/tools/display.ts
// Pure, client-safe helpers for rendering agent tool calls in the chat panel.
// No server imports — used by the chat tool renderers (components/badges/tools).

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
export function isCorpusMutationTool(toolName: string): "add" | "remove" | null {
  if (toolName === "corpus_add") return "add"
  if (toolName === "corpus_remove") return "remove"
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

/** Number of documents a corpus mutation actually changed (post-dedup). */
export function mutationCount(result: string): number | null {
  return pickNumber(result, ["added", "removed"])
}

/** Supplied ARKs skipped by corpus_add (already present or repeated). */
export function mutationDuplicates(result: string): number | null {
  return pickNumber(result, ["duplicates"])
}
