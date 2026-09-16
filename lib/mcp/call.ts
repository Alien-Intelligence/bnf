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
import { BnfMcpAuthError, BnfMcpError, BnfMcpRateLimitError } from "./errors"

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
 * The BnF MCP's SOFT-failure envelope. The transport and the `tools/call` both
 * succeed and `isError` stays unset, but the tool's own payload reports the
 * upstream failure and carries no `data` key at all — e.g. a Gallica HTTP 500
 * when `start_record` runs past `total`:
 *
 *     { "success": false, "error": "HTTP 500", "status_code": 500,
 *       "context": "bnf_search_catalogue" }
 */
interface McpFailureEnvelope {
  success: false
  // Declared optional AND unknown: only `success` is verified at runtime, so the
  // reader must re-check these before use.
  error?: unknown
  status_code?: unknown
  context?: unknown
}

function isFailureEnvelope(payload: unknown): payload is McpFailureEnvelope {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { success?: unknown }).success === false
  )
}

/** `Retry-After` (delta-seconds form) → milliseconds, or undefined. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

/**
 * Build the error for a soft failure, mapping the upstream status onto the same
 * taxonomy a transport-level failure produces.
 *
 * The envelope is the ONLY signal that an upstream 401/429 happened — the
 * transport returned 200 — so a bare `BnfMcpError` would make a terminal auth
 * failure indistinguishable from a transient one to any `instanceof` check.
 *
 * 404 is deliberately NOT mapped: `BnfMcpNotFoundError` means "ARK not found on
 * resolve" everywhere else in the codebase, and `retry.ts` treats it as
 * terminal. A 404 from a SEARCH tool is a different thing (routing / upstream
 * fault), so it stays a generic error rather than borrowing resolve semantics.
 */
function softFailureError(envelope: McpFailureEnvelope, toolName: string): BnfMcpError {
  const status = typeof envelope.status_code === "number" ? envelope.status_code : undefined
  const detail =
    typeof envelope.error === "string" && envelope.error.length > 0
      ? envelope.error
      : status !== undefined
        ? `HTTP ${status}`
        : "tool reported failure"
  const message = `MCP ${toolName}: ${detail}`

  if (status === 401 || status === 403) return new BnfMcpAuthError(message)
  if (status === 429) return new BnfMcpRateLimitError(message)
  return new BnfMcpError(message)
}

/**
 * Call one BnF MCP tool and return its parsed JSON payload.
 *
 * The BnF search tools return their payload as a single `{type:"text"}` content
 * block whose text is a `json.dumps` string (response_format defaults to
 * "json"), so we parse that text as `T`. Throws BnfMcpAuthError on 401/403 and
 * BnfMcpError on any transport / tool-level error, so the caller can coerce it
 * into a structured tool result the agent can react to.
 *
 * "Tool-level error" includes the `{ success: false }` soft failure: a resolved
 * `T` is therefore always a payload the tool itself considers successful, and
 * callers may reach into it without re-checking.
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
  if (res.status === 429) {
    // No caller wraps `callBnfTool` in `withRetry` today, so this does not (yet)
    // change retry behaviour — what it does change is what the AGENT is told:
    // the wait goes into the message, which rides out as the tool result, so the
    // model can pace itself instead of reading a generic failure. The typed
    // class also means a future `withRetry` wrap honours Retry-After for free.
    const waitMs = retryAfterMs(res.headers.get("retry-after"))
    throw new BnfMcpRateLimitError(
      waitMs === undefined
        ? "MCP tools/call rate limited (HTTP 429)"
        : `MCP tools/call rate limited (HTTP 429) — retry in ${Math.ceil(waitMs / 1000)}s`,
      waitMs,
    )
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

  const payload: unknown = JSON.parse(textBlock.text)

  // Surface the soft failure as the tool failure it is. Without this the caller
  // reaches for `data.records` on a payload that has no `data`, and the agent is
  // handed an opaque "TypeError: Cannot read properties of undefined" instead of
  // the upstream status.
  if (isFailureEnvelope(payload)) {
    throw softFailureError(payload, toolName)
  }

  return payload as T
}
