// lib/mcp/tools.ts
// BnF MCP tool names, as `tools/call` names them.
//
// These are the RAW, unprefixed names the MCP server exposes. They are distinct
// from `AGENT_TOOLS` / `MCP_TOOLS` in lib/agent/tools/constants.ts, which carry
// the `bnf__` server prefix the chat-sdk registry uses when the agent invokes a
// tool in-band. Anything calling `callBnfTool` directly wants these.
//
// Pure data — no server-only import.

/**
 * The name the BnF MCP server is registered under in the chat-sdk registry
 * (lib/agent/tools/mcp-servers.ts). The SDK prefixes every MCP tool as
 * `<server>__<tool>`, so `bnf__bnf_search_catalogue` is the agent-facing form of
 * `bnf_search_catalogue`. The rate limiter keys on this prefix.
 */
export const BNF_MCP_SERVER_NAME = "bnf" as const

/** The chat-sdk's server/tool separator (`prefixToolName` in @alien/chat-sdk). */
const MCP_PREFIX_SEP = "__" as const

/**
 * Every tool mcp-bnf registers (MCPs/mcp-bnf/src/tools/registry.py, one `NAME`
 * per module). The rate limiter maps each one to the BnF API it hits
 * (lib/mcp/rate-limit.ts BNF_MCP_TOOL_API); a tool added here without a bucket
 * is a compile error there.
 */
export const BNF_MCP_TOOLS = [
  // search/
  "bnf_search_catalogue",
  "bnf_get_catalogue_record",
  "bnf_search_gallica",
  "bnf_get_search_facets",
  // iiif/
  "bnf_get_manifest",
  "bnf_get_image_info",
  "bnf_get_image_url",
  "bnf_get_page_ocr_boxes",
  // document/
  "bnf_get_document_info",
  "bnf_get_document_pages",
  "bnf_get_document_toc",
  "bnf_get_page_text",
  "bnf_get_periodical_issues",
  // composite/
  "bnf_get_document_text",
  // semantic/
  "bnf_sparql_query",
  "bnf_find_person",
  "bnf_find_work",
  "bnf_resolve_entity",
] as const

export type BnfMcpToolName = (typeof BNF_MCP_TOOLS)[number]

/** BnF MCP search tools, keyed by the `corpus_search` source they serve. */
export const BNF_SEARCH_TOOL = {
  gallica: "bnf_search_gallica",
  catalogue: "bnf_search_catalogue",
} as const satisfies Record<string, BnfMcpToolName>

export type BnfSearchSource = keyof typeof BNF_SEARCH_TOOL

/** The agent-facing name of a BnF MCP tool: `bnf__<tool>`. */
export type BnfPrefixedToolName<T extends BnfMcpToolName = BnfMcpToolName> =
  `${typeof BNF_MCP_SERVER_NAME}${typeof MCP_PREFIX_SEP}${T}`

/** `bnf_search_catalogue` → `bnf__bnf_search_catalogue`, typed. */
export function bnfPrefixedToolName<T extends BnfMcpToolName>(tool: T): BnfPrefixedToolName<T> {
  return `${BNF_MCP_SERVER_NAME}${MCP_PREFIX_SEP}${tool}`
}

/**
 * The raw mcp-bnf tool name behind an agent-facing `bnf__<tool>` name, or null
 * when the name does not carry the BnF server prefix (a custom app tool,
 * another server's tool, or a bare prefix). Deliberately does NOT check the
 * tool against BNF_MCP_TOOLS: an unknown `bnf__` tool is still BnF egress, and
 * the rate-limited registry REFUSES it (isBnfMcpToolName in rate-limit.ts)
 * rather than letting it through unmetered.
 */
export function bnfToolFromPrefixed(prefixed: string): string | null {
  const prefix = BNF_MCP_SERVER_NAME + MCP_PREFIX_SEP
  if (!prefixed.startsWith(prefix)) return null
  const tool = prefixed.slice(prefix.length)
  return tool.length > 0 ? tool : null
}
