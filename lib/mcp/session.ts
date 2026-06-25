// lib/mcp/session.ts
// Streamable-HTTP MCP session handshake (session is OPTIONAL).
//
// The MCP spec's session flow is:
//
//   1. POST an `initialize` request → server responds 200, optionally with an
//      `Mcp-Session-Id` response header.
//   2. If a session id is returned, every subsequent request echoes it in the
//      `Mcp-Session-Id` *request* header until the session expires.
//
// The BnF MCP (mcp-base) runs **stateless**: `initialize` returns no
// `mcp-session-id` header and each request is self-contained — so no session
// header is needed, and one must NOT be required. It previously ran stateful,
// but per-pod in-memory sessions broke once the HPA scaled it past one replica
// (no shared store / no session affinity → `400 No valid session ID provided`
// on every request that missed the owning pod). See the project memory
// `bnf-mcp-stateless-multireplica`.
//
// We keep performing the handshake so the app stays forward-compatible with a
// stateful server: if a session id IS returned we thread it back as a header
// (the chat-sdk forwards `headers` on every request); if it is not, callers
// proceed without one.

import "server-only"

import {
  BNF_MCP_TIMEOUT_MS,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from "@/lib/constants"
import { withTimeout } from "./abort"
import { BnfMcpAuthError, BnfMcpError } from "./errors"

/**
 * Perform the MCP `initialize` handshake.
 *
 * Returns the server-assigned session id (`mcp-session-id` response header)
 * when the server runs *stateful*, or `null` when it runs *stateless* (no
 * session header — each request is self-contained). Callers must treat the
 * session as optional and only echo `Mcp-Session-Id` when it is non-null.
 *
 * Throws BnfMcpAuthError on 401/403 (bad token — not retryable) and
 * BnfMcpError on any other transport failure.
 */
export async function openMcpSession(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
    }),
    // Bound the handshake: abort on turn cancel OR a stalled transport.
    signal: withTimeout(signal, BNF_MCP_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    throw new BnfMcpAuthError(`MCP initialize auth failed (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new BnfMcpError(
      `MCP initialize failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
    )
  }

  // Stateless server → no header. Return null; callers omit `Mcp-Session-Id`.
  return res.headers.get("mcp-session-id")
}
