// models/feedback/schema.ts
// Re-exported Prisma type + domain enums for Feedback.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Feedback } from "@/lib/generated/prisma/client"

export type { Feedback }

/** What a feedback row points at. Carried as the `target` discriminator. */
export const FEEDBACK_TARGET = {
  SESSION: "session",
  NOTE: "note",
  TURN: "turn",
} as const
export type FeedbackTarget = (typeof FEEDBACK_TARGET)[keyof typeof FEEDBACK_TARGET]

/** 3-way CATEGORICAL quality rating. Maps to a future Langfuse score value. */
export const FEEDBACK_RATING = {
  BAD: "bad",
  OK: "ok",
  GREAT: "great",
} as const
export type FeedbackRating = (typeof FEEDBACK_RATING)[keyof typeof FEEDBACK_RATING]
