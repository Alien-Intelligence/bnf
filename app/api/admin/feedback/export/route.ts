/**
 * GET /api/admin/feedback/export
 *
 * Streams a CSV of every feedback row, resolved to its target. Admin-only —
 * same flat role gate and same resolution as /api/admin/feedback.
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden } from "@/lib/api-response"
import { toCsv } from "@/lib/csv"
import { FeedbackQueries } from "@/models/feedback/queries"

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const feedback = await FeedbackQueries.listAllResolvedForAdmin()

  const csv = toCsv(
    [
      "feedback_id",
      "created_at",
      "rating",
      "target",
      "target_id",
      "target_label",
      "project_id",
      "project_name",
      "user_name",
      "user_email",
      "comment",
    ],
    feedback.map((f) => [
      f.id,
      f.createdAt,
      f.rating,
      f.target,
      f.targetId,
      f.resolved?.label ?? "",
      f.projectId,
      f.projectName,
      f.userName,
      f.userEmail,
      f.comment ?? "",
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="feedback.csv"',
      "Cache-Control": "no-store",
    },
  })
})
