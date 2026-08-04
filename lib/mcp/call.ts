// lib/mcp/call.ts
// App-side MCP `tools/call` against the (stateless) BnF MCP.
//
// The agent reaches BnF MCP tools through the chat-sdk registry (mcpServers).
// This is the OTHER path: an app-owned tool handler (corpus_search) that calls
// a BnF search tool itself, so it can funnel the hits into the research buffer
// instead of pouring a raw result list into the model's context. It mirrors the
// chat-sdk's internal `rpc` transport (JSON *or* SSE-framed JSON-RPC response)
// and the handshake discipline in lib/mcp/session.ts.
//
// The BnF MCP runs stateless (see session.ts) so no `initialize`/Mcp-Session-Id
// is threaded here — each `tools/call` is self-contained. Bounded by
// BNF_MCP_TIMEOUT_MS (CLAUDE_ERROR_PATTERNS §14).

import "server-only"

import { BNF_MCP_TIMEOUT_MS } from "@/lib/constants"
import { withTimeout } from "./abort"
import { BnfMcpAuthError, BnfMcpError } from "./errors"

interface JsonRpcOk<T> {
  jsonrpc: "2.0"
  id: number | string
  result: T
}
interface JsonRpcErr {
  jsonrpc: "2.0"
  id: number | string
  error: { code: number; message: string; data?: unknown }
}

/** Minimal MCP `tools/call` result shape (content blocks + error flag). */
interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

/**
 * Call one BnF MCP tool and return its parsed JSON payload.
 *
 * The BnF search tools return their payload as a single `{type:"text"}` content
 * block whose text is a `json.dumps` string (response_format defaults to
 * "json"), so we parse that text as `T`. Throws BnfMcpAuthError on 401/403 and
 * BnfMcpError on any transport / tool-level error, so the caller can coerce it
 * into a structured tool result the agent can react to.
 */
export async function callBnfTool<T>(
  url: string,
  token: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
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
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    // Bound the call: abort on turn cancel OR a stalled transport.
    signal: withTimeout(signal, BNF_MCP_TIMEOUT_MS),
  })

  if (res.status === 401 || res.status === 403) {
    throw new BnfMcpAuthError(`MCP tools/call auth failed (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new BnfMcpError(`MCP tools/call failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }

  const ctype = res.headers.get("content-type") ?? ""
  let envelope: JsonRpcOk<McpToolCallResult> | JsonRpcErr
  if (ctype.includes("text/event-stream")) {
    const body = await res.text()
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "))
    if (!dataLine) throw new BnfMcpError("MCP tools/call: SSE response had no data line")
    envelope = JSON.parse(dataLine.slice(6)) as JsonRpcOk<McpToolCallResult> | JsonRpcErr
  } else {
    envelope = (await res.json()) as JsonRpcOk<McpToolCallResult> | JsonRpcErr
  }

  if ("error" in envelope) {
    throw new BnfMcpError(`MCP ${toolName}: ${envelope.error.message}`)
  }

  const result = envelope.result
  if (result.isError) {
    const text = result.content?.find((c) => typeof c.text === "string")?.text ?? "tool error"
    throw new BnfMcpError(`MCP ${toolName}: ${text.slice(0, 200)}`)
  }

  const textBlock = result.content?.find((c) => c.type === "text" && typeof c.text === "string")
  if (!textBlock?.text) {
    throw new BnfMcpError(`MCP ${toolName}: no text content in result`)
  }

  return JSON.parse(textBlock.text) as T
}
