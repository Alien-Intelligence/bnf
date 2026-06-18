"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "@/lib/api-fetch"

// ---------------------------------------------------------------------------
// Public types
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

/** A synthetic domain event derived from a persisted ToolCall row. */
export type StreamDomainEvent =
  | { type: "corpus_event"; data: { kind: "add" | "remove"; count: number; versionSeq: number } }
  | { type: "memory_event"; data: { kind: "write"; itemId: string; section: string } }
  | { type: "ingest_event"; data: { kind: "submitted-stub" | "submitted"; jobId?: string; status?: string } }

export type UseTurnStreamResult = {
  messages: StreamMessage[]
  toolCalls: StreamToolCall[]
  /** Domain events derived from past tool calls — populated on snapshot. */
  domainEvents: StreamDomainEvent[]
  isConnecting: boolean
  isStreaming: boolean
  error: string | null
  post: (text: string) => Promise<void>
  cancel: () => Promise<void>
}

// ---------------------------------------------------------------------------
// SSE frame shapes from the server
// ---------------------------------------------------------------------------

type SnapshotPayload = {
  messages: StreamMessage[]
  toolCalls: StreamToolCall[]
  /** Synthetic domain events derived from past tool calls. May be absent on
   *  old server versions; always treat as optional. */
  events?: StreamDomainEvent[]
}

type TextDeltaPayload = {
  messageId: string
  text: string
}

type ToolCallEndPayload = StreamToolCall

type MessageEndPayload = {
  messageId: string
  stopReason: string | null
}

type ErrorPayload = {
  messageId?: string
  message: string
}

type ClosedPayload = {
  reason: "done" | "error" | "canceled"
}

type SseFrame =
  | { event: "snapshot"; data: SnapshotPayload }
  | { event: "text-delta"; data: TextDeltaPayload }
  | { event: "tool-call-end"; data: ToolCallEndPayload }
  | { event: "tool-result"; data: ToolCallEndPayload }
  | { event: "message-end"; data: MessageEndPayload }
  | { event: "error"; data: ErrorPayload }
  | { event: "closed"; data: ClosedPayload }
  | { event: "usage"; data: unknown }

// ---------------------------------------------------------------------------
// SSE parser — accumulates raw bytes across reads, splits on double-newline
// ---------------------------------------------------------------------------

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n")
  let eventName = ""
  let dataStr = ""

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventName = line.slice("event: ".length).trim()
    } else if (line.startsWith("data: ")) {
      dataStr = line.slice("data: ".length).trim()
    }
  }

  if (!eventName || !dataStr) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(dataStr)
  } catch {
    return null
  }

  return { event: eventName, data: parsed } as SseFrame
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function upsertToolCall(
  prev: StreamToolCall[],
  updated: StreamToolCall,
): StreamToolCall[] {
  const idx = prev.findIndex((t) => t.id === updated.id)
  if (idx === -1) return [...prev, updated]
  const copy = [...prev]
  copy[idx] = updated
  return copy
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_DELAY_MS = 1_000

export function useTurnStream(
  appSessionId: string | null,
): UseTurnStreamResult {
  const [messages, setMessages] = useState<StreamMessage[]>([])
  const [toolCalls, setToolCalls] = useState<StreamToolCall[]>([])
  const [domainEvents, setDomainEvents] = useState<StreamDomainEvent[]>([])
  const [isConnecting, setConnecting] = useState(false)
  const [isStreaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable ref so the stream loop can read current state without stale closures.
  const abortRef = useRef<AbortController | null>(null)
  const seenSeqRef = useRef<number>(0)
  const reconnectCountRef = useRef<number>(0)

  // -------------------------------------------------------------------------
  // Stream lifecycle
  // -------------------------------------------------------------------------

  const openStream = useCallback(
    async (sid: string, fromSeq: number, signal: AbortSignal) => {
      setConnecting(true)
      setError(null)

      let res: Response
      try {
        res = await apiFetch(
          `/api/sessions/${sid}/stream?fromSeq=${fromSeq}`,
          { signal },
        )
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return
        throw err
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} opening stream`)
      }

      if (!res.body) {
        throw new Error("Empty response body from stream endpoint")
      }

      setConnecting(false)

      const reader = res.body.getReader()
      const decoder = new TextDecoder("utf-8")
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value)

          // Split on double-newline to get complete SSE frames.
          const frames = buffer.split("\n\n")
          // The last segment may be incomplete — keep it in the buffer.
          buffer = frames.pop() ?? ""

          for (const raw of frames) {
            const trimmed = raw.trim()
            if (!trimmed || trimmed.startsWith(":")) {
              // Blank line or heartbeat comment — skip.
              continue
            }

            const frame = parseSseFrame(trimmed)
            if (!frame) continue

            switch (frame.event) {
              case "snapshot": {
                const payload = frame.data as SnapshotPayload
                setMessages(payload.messages)
                setToolCalls(payload.toolCalls)
                if (payload.events) {
                  setDomainEvents(payload.events)
                }
                // Track highest seq so reconnect starts from here.
                const maxSeq = payload.messages.reduce(
                  (m, msg) => Math.max(m, msg.seq),
                  seenSeqRef.current,
                )
                seenSeqRef.current = maxSeq
                break
              }

              case "text-delta": {
                const payload = frame.data as TextDeltaPayload
                setStreaming(true)
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === payload.messageId
                      ? { ...m, content: (m.content ?? "") + payload.text }
                      : m,
                  ),
                )
                break
              }

              case "tool-call-end":
              case "tool-result": {
                const payload = frame.data as ToolCallEndPayload
                setToolCalls((prev) => upsertToolCall(prev, payload))
                break
              }

              case "message-end": {
                const payload = frame.data as MessageEndPayload
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === payload.messageId
                      ? { ...m, status: "done", finishedAt: new Date().toISOString() }
                      : m,
                  ),
                )
                setStreaming(false)
                break
              }

              case "error": {
                const payload = frame.data as ErrorPayload
                if (payload.messageId) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === payload.messageId
                        ? {
                            ...m,
                            status: "error",
                            error: payload.message,
                            finishedAt: new Date().toISOString(),
                          }
                        : m,
                    ),
                  )
                }
                setError(payload.message)
                setStreaming(false)
                break
              }

              case "closed": {
                // Server closed the stream cleanly — nothing more to read.
                setStreaming(false)
                return
              }

              case "usage":
                // Token usage — not required for the UI this slice.
                break
            }
          }
        }
      } finally {
        reader.cancel()
      }
    },
    [],
  )

  // -------------------------------------------------------------------------
  // Connect with reconnect loop
  // -------------------------------------------------------------------------

  // Reset state whenever the session changes (including to null).
  // Isolated in its own effect so the connect effect below stays clean.
  useEffect(() => {
    return () => {
      // Cleanup runs before the next value of appSessionId takes effect.
      // This clears stale state from the previous session.
      setMessages([])
      setToolCalls([])
      setDomainEvents([])
      setStreaming(false)
      setConnecting(false)
      setError(null)
      seenSeqRef.current = 0
      reconnectCountRef.current = 0
    }
  }, [appSessionId])

  useEffect(() => {
    if (!appSessionId) return

    // Capture as a non-nullable const so TypeScript narrows inside async closures.
    const sid: string = appSessionId
    const controller = new AbortController()
    abortRef.current = controller

    let cancelled = false

    async function connect() {
      reconnectCountRef.current = 0

      while (!cancelled && reconnectCountRef.current <= MAX_RECONNECT_ATTEMPTS) {
        try {
          await openStream(sid, seenSeqRef.current, controller.signal)
          // Stream ended cleanly — no reconnect needed.
          break
        } catch (err) {
          if (cancelled) break
          if ((err as { name?: string }).name === "AbortError") break

          reconnectCountRef.current += 1
          if (reconnectCountRef.current > MAX_RECONNECT_ATTEMPTS) {
            const message =
              err instanceof Error ? err.message : "Stream connection failed"
            setError(message)
            setConnecting(false)
            setStreaming(false)
            break
          }

          // Exponential backoff before retry.
          const delay =
            RECONNECT_BASE_DELAY_MS * 2 ** (reconnectCountRef.current - 1)
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      controller.abort()
      abortRef.current = null
    }
  }, [appSessionId, openStream])

  // -------------------------------------------------------------------------
  // post() — send a user turn
  // -------------------------------------------------------------------------

  const post = useCallback(
    async (text: string): Promise<void> => {
      if (!appSessionId) return

      const now = new Date().toISOString()

      // Optimistic user message (seq unknown until snapshot refreshes).
      const optimisticUserId = `optimistic-user-${Date.now()}`
      const optimisticAsstId = `optimistic-asst-${Date.now()}`

      const optimisticUser: StreamMessage = {
        id: optimisticUserId,
        seq: -1,
        role: "user",
        content: text,
        status: "done",
        error: null,
        model: null,
        startedAt: null,
        finishedAt: now,
        createdAt: now,
      }

      const optimisticAsst: StreamMessage = {
        id: optimisticAsstId,
        seq: -1,
        role: "assistant",
        content: null,
        status: "streaming",
        error: null,
        model: null,
        startedAt: now,
        finishedAt: null,
        createdAt: now,
      }

      setMessages((prev) => [...prev, optimisticUser, optimisticAsst])
      setStreaming(true)

      const res = await apiFetch(`/api/sessions/${appSessionId}/turn`, {
        method: "POST",
        body: JSON.stringify({ text }),
      })

      if (!res.ok) {
        // Roll back the optimistic messages and surface the error.
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== optimisticUserId && m.id !== optimisticAsstId,
          ),
        )
        setStreaming(false)
        const body = await res.json().catch(() => ({}))
        throw new Error(
          (body as { error?: string }).error ??
            `HTTP ${res.status} starting turn`,
        )
      }

      // The snapshot event that arrives on the stream will overwrite the
      // optimistic messages with their real IDs and seqs.
    },
    [appSessionId],
  )

  // -------------------------------------------------------------------------
  // cancel() — abort the running turn
  // -------------------------------------------------------------------------

  const cancel = useCallback(async (): Promise<void> => {
    if (!appSessionId) return

    const res = await apiFetch(`/api/sessions/${appSessionId}/turn`, {
      method: "DELETE",
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(
        (body as { error?: string }).error ?? `HTTP ${res.status} canceling turn`,
      )
    }

    // The stream will emit a `closed` event soon; state updates come from there.
  }, [appSessionId])

  return {
    messages,
    toolCalls,
    domainEvents,
    isConnecting,
    isStreaming,
    error,
    post,
    cancel,
  }
}
