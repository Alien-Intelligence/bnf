/**
 * GET /api/admin/feedback
 *
 * Every feedback row across every project, each resolved to the note, session,
 * or turn it concerns. Admin-only — flat role gate enforced inline (see
 * /api/admin/usage). Resolution lives in FeedbackQueries so the CSV export
 * reuses the same rows.
 *
 * Response shape: AdminFeedbackResponse
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden, ok } from "@/lib/api-response"
import { FeedbackQueries } from "@/models/feedback/queries"
import type { AdminFeedbackRow } from "@/models/feedback/schema"

export type AdminFeedbackResponse = {
  feedback: AdminFeedbackRow[]
}

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const feedback = await FeedbackQueries.listAllResolvedForAdmin()
  return ok<AdminFeedbackResponse>({ feedback })
})
