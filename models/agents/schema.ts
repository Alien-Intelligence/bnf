// models/agents/schema.ts
// Domain constants, named query shapes, and derived types for the agents model.
// Covers both the corpus agent (scope="corpus") and the research agent
// (scope="research") — they share persistence, streaming runtime, and SSE
// event vocabulary; they differ only in prompt and enabled tool set.
// No imports from other model directories — schema.ts is the foundation layer.
// See playbook/models.md import diagram.

import "server-only"

// ---------------------------------------------------------------------------
// Domain status enums
// ---------------------------------------------------------------------------

/**
 * Status of an in-progress or completed agent turn (message row).
 * Values mirror Message.status in the Prisma schema.
 */
export const TURN_STATUS = {
  STREAMING: "streaming",
  DONE: "done",
  ERROR: "error",
  CANCELED: "canceled",
} as const

export type TurnStatus = (typeof TURN_STATUS)[keyof typeof TURN_STATUS]

// Re-export the Prisma-generated model types so callers never import from
// @/lib/generated/prisma/client directly (per models/users/schema.ts pattern).
export type { AppSession, Message, ToolCall } from "@/lib/generated/prisma/client"

// ---------------------------------------------------------------------------
// Composite types returned to the API layer
// ---------------------------------------------------------------------------

/**
 * A snapshot of all messages and tool calls for an agent session, from a
 * given sequence number onwards. Used by the SSE route for reattach: the
 * client sends ?fromSeq=N and receives only new content.
 *
 * `activeMessageId` — the ID of the currently-streaming Message row, or null
 * when the session is idle. Clients use this to decide whether to open a new
 * SSE stream (activeMessageId non-null) or just render the history.
 *
 * Field selection is intentional: only fields needed by the UI are included.
 * `usage` is excluded (emitted live as a typed SSE event); `thinking` IS
 * included so a reattaching client can re-render the reasoning block of a
 * completed turn — the live stream only carries reasoning for the active turn.
 */
export type TurnSnapshot = {
  messages: {
    id: string
    seq: number
    role: string
    content: string | null
    thinking: string | null
    status: string
    error: string | null
    model: string | null
    startedAt: Date | null
    finishedAt: Date | null
    createdAt: Date
  }[]
  toolCalls: {
    id: string
    messageId: string
    tool: string
    input: unknown
    output: unknown
    status: string
    source: string
    serverName: string | null
    latencyMs: number | null
    error: string | null
    createdAt: Date
    finishedAt: Date | null
  }[]
  activeMessageId: string | null
}
