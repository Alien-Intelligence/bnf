// models/agents/types.ts
// Zod schemas for agent API request validation and their inferred types.
// These are what route handlers validate against and what client hooks import.
//
// DB-derived shapes (TurnSnapshot, AppSession, Message, ToolCall) live in
// schema.ts, not here — per playbook/models.md.

import { z } from "zod"

// ---------------------------------------------------------------------------
// POST /api/sessions/:sid/messages — start a new agent turn
// ---------------------------------------------------------------------------

/**
 * Input for submitting a user message to start a new agent turn.
 * The route handler validates the body against this schema before delegating
 * to AgentService.startTurn().
 */
export const postTurnSchema = z.object({
  /**
   * The user's message text. Trimmed; must be non-empty.
   * Max 8 000 characters matches the design's conversational input contract
   * (not a document field — it's a chat message).
   */
  text: z.string().trim().min(1).max(8000),
})

export type PostTurnInput = z.infer<typeof postTurnSchema>

// ---------------------------------------------------------------------------
// GET /api/sessions/:sid/messages — SSE stream or reattach snapshot
// ---------------------------------------------------------------------------

/**
 * Query params for the SSE stream endpoint.
 * `fromSeq` drives the reattach path: the client sends its last-seen seq + 1
 * to receive only new content. Omit (or pass 0) for full history.
 */
export const streamQuerySchema = z.object({
  fromSeq: z.coerce.number().int().min(0).optional(),
})

export type StreamQueryInput = z.infer<typeof streamQuerySchema>
