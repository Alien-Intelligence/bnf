// lib/mcp/tools.ts
// BnF MCP tool names, as `tools/call` names them.
//
// These are the RAW, unprefixed names the MCP server exposes. They are distinct
// from `AGENT_TOOLS` / `MCP_TOOLS` in lib/agent/tools/constants.ts, which carry
// the `bnf__` server prefix the chat-sdk registry uses when the agent invokes a
// tool in-band. Anything calling `callBnfTool` directly wants these.
//
// Pure data — no server-only import.

/** BnF MCP search tools, keyed by the `corpus_search` source they serve. */
export const BNF_SEARCH_TOOL = {
  gallica: "bnf_search_gallica",
  catalogue: "bnf_search_catalogue",
} as const

export type BnfSearchSource = keyof typeof BNF_SEARCH_TOOL
