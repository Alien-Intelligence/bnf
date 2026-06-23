"use client"

// hooks/api/turn-stream.ts
// Thin adapter over @alien/chat-sdk's durable `useChat`.
//
// The bespoke SSE consumer (custom fetch loop, reconnect, optimistic state)
// has been replaced by the SDK's `useChat({ resume })`, which talks to the
// durable chat route (app/api/sessions/[sid]/messages). This module re-exposes
// the SAME `UseTurnStreamResult` shape the existing UI consumes (flat
// messages / toolCalls / domainEvents + post/cancel), so the chat panel and
// the page clients need no changes — it maps the SDK's turn tree back to the
// flat shape on each render.
//
// Smoothing is left to <StreamingMarkdown> (which animates the word reveal),
// so the SDK smoother is disabled here to avoid double animation.

import { useCallback, useMemo, useState } from "react"
import { useChat, type UseChatReturn } from "@alien/chat-sdk/react"
import type { AgentPart, ChatTurn } from "@alien/chat-sdk"
import { apiFetch } from "@/lib/api-fetch"
import { CHAT_STREAM_REVEAL_MS } from "@/lib/constants"

// ---------------------------------------------------------------------------
// Public types (unchanged — the UI depends on these)
// ---------------------------------------------------------------------------

export type StreamMessage = {
  id: string
  seq: number
  role: "user" | "assistant" | "event"
  content: string | null
  status: "draft" | "streaming" | "done" | "error" | "canceled"
  error: string | null
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type StreamToolCall = {
  id: string
  messageId: string
  tool: string
  input: unknown
  output: unknown
  status: "running" | "ok" | "error"
  source: "custom" | "mcp"
  serverName: string | null
  latencyMs: number | null
  createdAt: string
  finishedAt: string | null
}

export type StreamDomainEvent =
  | { type: "corpus_event"; data: { kind: "add" | "remove"; count: number; versionSeq: number } }
  | { type: "memory_event"; data: { kind: "write"; itemId: string; section: string } }
  | { type: "ingest_event"; data: { kind: "submitted-stub" | "submitted"; jobId?: string; status?: string } }
  | { type: "note_event"; data: { kind: "created" | "updated"; noteId: string; title: string } }

export type UseTurnStreamResult = {
  messages: StreamMessage[]
  toolCalls: StreamToolCall[]
  domainEvents: StreamDomainEvent[]
  isConnecting: boolean
  isStreaming: boolean
  error: string | null
  post: (text: string) => Promise<void>
  cancel: () => Promise<void>
  /** The underlying SDK chat handle — pass to `<ChatPanel chat={…} />`. The
   *  flat fields above are derived from it for non-ChatPanel consumers. */
  chat: UseChatReturn
}

// ---------------------------------------------------------------------------
// Mapping: SDK turn tree → flat messages / toolCalls
// ---------------------------------------------------------------------------

const BASE_PATH = process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""

const DOMAIN_EVENT_TYPES = new Set([
  "corpus_event",
  "memory_event",
  "ingest_event",
  "note_event",
])

function joinText(parts: AgentPart[]): string {
  let out = ""
  for (const part of parts) {
    if (part.kind === "text") out += part.text
    else if (part.kind === "instance") out += joinText(part.children)
  }
  return out
}

function deriveFlat(turns: ChatTurn[]): {
  messages: StreamMessage[]
  toolCalls: StreamToolCall[]
} {
  const messages: StreamMessage[] = []
  const toolCalls: StreamToolCall[] = []
  const stamp = new Date().toISOString()

  turns.forEach((turn, index) => {
    if (turn.role === "user") {
      messages.push({
        id: turn.id,
        seq: index,
        role: "user",
        content: turn.text,
        status: "done",
        error: null,
        model: null,
        startedAt: null,
        finishedAt: null,
        createdAt: stamp,
      })
      return
    }
    if (turn.role !== "assistant") return

    messages.push({
      id: turn.id,
      seq: index,
      role: "assistant",
      content: joinText(turn.parts),
      status: turn.streaming ? "streaming" : turn.error ? "error" : "done",
      error: turn.error,
      model: null,
      startedAt: null,
      finishedAt: null,
      createdAt: stamp,
    })

    for (const part of turn.parts) {
      if (part.kind !== "tool") continue
      const tc = part.tool
      const isMcp = tc.toolName.includes("__")
      toolCalls.push({
        id: tc.toolUseId,
        messageId: turn.id,
        tool: tc.toolName,
        input: tc.input,
        output: tc.result,
        status: tc.running ? "running" : tc.isError ? "error" : "ok",
        source: isMcp ? "mcp" : "custom",
        serverName: isMcp ? (tc.toolName.split("__")[0] ?? null) : null,
        latencyMs: tc.endedAt != null ? tc.endedAt - tc.startedAt : null,
        createdAt: new Date(tc.startedAt).toISOString(),
        finishedAt: tc.endedAt != null ? new Date(tc.endedAt).toISOString() : null,
      })
    }
  })

  return { messages, toolCalls }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param appSessionId  the durable session whose turn this stream drives.
 * @param model  optional OpenRouter model id. When set, it is merged into every
 *   request body as `{ model }` — the server handler reads `body.model ?? cfg.model`,
 *   so the chosen model drives the next turn. Pass this ONLY under the openrouter
 *   provider: a vendor-namespaced id (`anthropic/…`) sent to the direct-Anthropic
 *   provider would be rejected. Omit it (undefined) and the handler falls back to
 *   its configured model.
 */
export function useTurnStream(
  appSessionId: string | null,
  model?: string,
): UseTurnStreamResult {
  const endpoint = `${BASE_PATH}/api/sessions/${appSessionId ?? "_none_"}/messages`
  const [domainEvents, setDomainEvents] = useState<StreamDomainEvent[]>([])

  // Reset the live domain-event log when the session changes — the
  // store-previous-value + reset-during-render pattern (no effect needed).
  const [prevSessionId, setPrevSessionId] = useState(appSessionId)
  if (prevSessionId !== appSessionId) {
    setPrevSessionId(appSessionId)
    setDomainEvents([])
  }

  const chat = useChat({
    endpoint,
    resume: appSessionId ? { sessionId: appSessionId } : undefined,
    // Per-request model override (openrouter only). Only attach `body.model`
    // when a model is set — an absent key lets the handler use its configured
    // default, and never sends a namespaced id down the direct-Anthropic path.
    ...(model ? { body: { model } } : {}),
    // The SDK smoother drives the word-by-word reveal; <StreamingMarkdown> is
    // rendered with streaming=false (plain markdown of the current content).
    smooth: { delayMs: CHAT_STREAM_REVEAL_MS, chunking: "word" },
    onDomainEvent: (event) => {
      if (DOMAIN_EVENT_TYPES.has(event.type)) {
        setDomainEvents((prev) => [...prev, event as StreamDomainEvent])
      }
    },
  })

  const { messages, toolCalls } = useMemo(() => deriveFlat(chat.turns), [chat.turns])

  const post = useCallback(
    async (text: string): Promise<void> => {
      if (!appSessionId) return
      await chat.sendMessage(text)
    },
    [appSessionId, chat],
  )

  const cancel = useCallback(async (): Promise<void> => {
    if (!appSessionId) return
    chat.cancel()
    await apiFetch(`/api/sessions/${appSessionId}/messages`, { method: "DELETE" }).catch(() => {
      // Best-effort: the turn is detached server-side; UI state follows the stream.
    })
  }, [appSessionId, chat])

  return {
    messages,
    toolCalls,
    domainEvents,
    isConnecting: false,
    isStreaming: chat.isStreaming,
    error: chat.error,
    post,
    cancel,
    chat,
  }
}
