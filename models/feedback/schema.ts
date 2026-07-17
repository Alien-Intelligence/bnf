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

/**
 * What a feedback row's target resolved to. `label` is the note title, session
 * title, or a short excerpt of the rated turn. `sessionScope` (corpus|research)
 * lets the client pick the right step route for session/turn deep-links; it is
 * null for notes (which always live in the Carnet). `null` for the whole
 * object means the target was deleted since the feedback was left.
 */
export type AdminFeedbackResolved = {
  label: string
  sessionScope: string | null
}

/** One feedback row enriched for the admin console. Dates are ISO strings. */
export type AdminFeedbackRow = {
  id: string
  createdAt: string
  rating: string
  comment: string | null
  target: string
  targetId: string
  projectId: string
  projectName: string
  userName: string
  userEmail: string
  resolved: AdminFeedbackResolved | null
}
