// lib/agent/runtime/types.ts
// Pure types — no server-only import, safe to import from client-side code.
// All server-side runtime modules import from here.

import type { ChatEvent } from "@alien/chat-sdk/events"

// ---------------------------------------------------------------------------
// Domain events emitted by agent tool handlers into the pubsub channel.
// These extend the ChatEvent stream so SSE consumers receive a unified event
// feed without knowing whether the source was the Anthropic runner or a tool.
// ---------------------------------------------------------------------------

export type DomainEvent =
  | {
      type: "corpus_event"
      data: { kind: "add" | "remove"; count: number; versionSeq: number }
    }
  | {
      type: "memory_event"
      data: { kind: "write"; itemId: string; section: string }
    }
  | {
      type: "ingest_event"
      data: {
        kind: "submitted-stub" | "submitted"
        jobId?: string
        status?: string
      }
    }
  | {
      type: "note_event"
      data: { kind: "created" | "updated"; noteId: string; title: string }
    }
  | {
      // Full snapshot of persisted messages + tool calls for SSE reattach.
      type: "snapshot"
      data: { messages: unknown[]; toolCalls: unknown[] }
    }
  | {
      // Emitted periodically during long-running tool calls so SSE proxies
      // don't close the connection on silence.
      type: "heartbeat"
      data: Record<string, never>
    }
  | {
      // Terminal event: the turn is finished and the channel is closing.
      type: "closed"
      data: { reason: string }
    }

// The unified event type streamed over the pubsub channel and forwarded to
// SSE consumers.  ChatEvent covers all Anthropic/runner events; DomainEvent
// covers tool-side side-effects.
export type AppEvent = ChatEvent | DomainEvent
