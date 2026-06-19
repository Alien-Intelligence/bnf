// lib/mcp/session.ts
// Streamable-HTTP MCP session handshake.
//
// The BnF MCP (mcp-base, https://bnf.mcp.alien.club/mcp) is a *stateful*
// server: a bare `tools/list` or `tools/call` is rejected with
// `400 Bad Request: Missing session ID`. The MCP spec's session flow is:
//
//   1. POST an `initialize` request → server responds 200 with an
//      `Mcp-Session-Id` response header.
//   2. Every subsequent request echoes that id in the `Mcp-Session-Id`
//      *request* header until the session expires.
//
// This contrasts with the alien MCP used by publisher-demo, which accepts
// header-only Bearer auth with no session — that is why the chat-sdk's naive
// stateless MCP client works there but not against the BnF MCP. We bridge the
// gap by performing the handshake ourselves and threading the session id back
// in as a header (the chat-sdk forwards `headers` on every request, and the
// direct BnfMcpClient adds it explicitly).

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
 * Perform the MCP `initialize` handshake and return the server-assigned
 * session id (the `mcp-session-id` response header).
 *
 * Throws BnfMcpAuthError on 401/403 (bad token — not retryable) and
 * BnfMcpError on any other transport failure or a missing session-id header.
 */
export async function openMcpSession(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
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

  const sessionId = res.headers.get("mcp-session-id")
  if (!sessionId) {
    throw new BnfMcpError(
      "MCP initialize succeeded but returned no mcp-session-id header",
    )
  }

  return sessionId
}
