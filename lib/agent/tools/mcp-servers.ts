// lib/agent/tools/mcp-servers.ts
// Resolve the BnF MCP server entry for a turn. Extracted to a leaf module (no
// imports from ./index or ./registry-factory) so BOTH the main turn registry
// (registry-factory.ts) and a spawned sub-agent's child registry (spawn.ts) can
// attach the same BnF search capability without an import cycle
// (spawn → registry-factory → index → spawn).
import "server-only"

import { BNF_MCP_TIMEOUT_MS } from "@/lib/constants"
import { requireMcpEnv } from "@/lib/env"
import { openMcpSession } from "@/lib/mcp/session"
import { BNF_MCP_SERVER_NAME } from "@/lib/mcp/tools"

/** The BnF MCP entry: its per-call ceiling is BNF_MCP_TIMEOUT_MS, stated here
 *  (not the SDK default) because the rate limiter's reservation TTL is
 *  computed from it (lib/mcp/rate-limit.ts). */
export type McpServerEntry = { name: string; url: string; headers: Record<string, string>; timeoutMs: number }

/**
 * The BnF MCP server entry for a turn, or `[]` when the MCP env is absent / the
 * handshake fails. Never throws — a missing MCP degrades to "no BnF search this
 * turn" rather than crashing the turn.
 */
export async function resolveMcpServers(signal?: AbortSignal): Promise<McpServerEntry[]> {
  try {
    const mcpEnv = requireMcpEnv()
    // The BnF MCP runs stateless (no session). We still run the `initialize`
    // handshake for forward-compat with a stateful server: if it returns a
    // session id we thread it back as a header so the chat-sdk's (session-blind)
    // client echoes it on every tools/list + tools/call; if it returns null we
    // omit the header entirely. See lib/mcp/session.ts.
    const sessionId = await openMcpSession(mcpEnv.BNF_MCP_URL, mcpEnv.BNF_MCP_TOKEN, signal)
    const headers: Record<string, string> = { Authorization: `Bearer ${mcpEnv.BNF_MCP_TOKEN}` }
    if (sessionId) headers["Mcp-Session-Id"] = sessionId
    return [{ name: BNF_MCP_SERVER_NAME, url: mcpEnv.BNF_MCP_URL, headers, timeoutMs: BNF_MCP_TIMEOUT_MS }]
  } catch (err) {
    console.warn(
      "[mcp-servers] BnF MCP unavailable — agent has no BnF search tools for " +
        `this turn: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}
