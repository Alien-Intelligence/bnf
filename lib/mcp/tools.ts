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
export const BNF_MCP_TOOL = {
  // search/
  SEARCH_CATALOGUE: "bnf_search_catalogue",
  GET_CATALOGUE_RECORD: "bnf_get_catalogue_record",
  SEARCH_GALLICA: "bnf_search_gallica",
  GET_SEARCH_FACETS: "bnf_get_search_facets",
  // iiif/
  GET_MANIFEST: "bnf_get_manifest",
  GET_IMAGE_INFO: "bnf_get_image_info",
  GET_IMAGE_URL: "bnf_get_image_url",
  GET_PAGE_OCR_BOXES: "bnf_get_page_ocr_boxes",
  // document/
  GET_DOCUMENT_INFO: "bnf_get_document_info",
  GET_DOCUMENT_PAGES: "bnf_get_document_pages",
  GET_DOCUMENT_TOC: "bnf_get_document_toc",
  GET_PAGE_TEXT: "bnf_get_page_text",
  GET_PERIODICAL_ISSUES: "bnf_get_periodical_issues",
  // composite/
  GET_DOCUMENT_TEXT: "bnf_get_document_text",
  // semantic/
  SPARQL_QUERY: "bnf_sparql_query",
  FIND_PERSON: "bnf_find_person",
  FIND_WORK: "bnf_find_work",
  RESOLVE_ENTITY: "bnf_resolve_entity",
} as const

/** Every mcp-bnf tool name, as a tuple. */
export const BNF_MCP_TOOLS = Object.values(BNF_MCP_TOOL)

export type BnfMcpToolName = (typeof BNF_MCP_TOOL)[keyof typeof BNF_MCP_TOOL]

/** BnF MCP search tools, keyed by the `corpus_search` source they serve. */
export const BNF_SEARCH_TOOL = {
  gallica: BNF_MCP_TOOL.SEARCH_GALLICA,
  catalogue: BNF_MCP_TOOL.SEARCH_CATALOGUE,
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
 * when the name does not carry the BnF server prefix (a custom app tool or
 * another server's tool). A name WITH the prefix is BnF egress whatever
 * follows it — a bare `bnf__` yields "" — and it is NOT checked against
 * BNF_MCP_TOOLS here: the rate-limited registry refuses every name the
 * limiter does not know (isBnfMcpToolName in rate-limit.ts), the empty one
 * included, so nothing reaches mcp-bnf unmetered.
 */
export function bnfToolFromPrefixed(prefixed: string): string | null {
  const prefix = BNF_MCP_SERVER_NAME + MCP_PREFIX_SEP
  if (!prefixed.startsWith(prefix)) return null
  return prefixed.slice(prefix.length)
}
