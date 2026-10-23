/**
 * GET /api/admin/feedback/export
 *
 * Streams a CSV of every feedback row, resolved to its target. Admin-only
 * (UserPolicy.exportAdminData), same resolution as /api/admin/feedback.
 */
import { withAuth } from "@/app/api/_middleware"
import { csvDownloadHeaders } from "@/lib/constants"
import { toCsv } from "@/lib/csv"
import { UserPolicy } from "@/models/users/policy"
import { FeedbackQueries } from "@/models/feedback/queries"

export const GET = withAuth(async (_req, _user, bouncer) => {
  await bouncer.with(UserPolicy).authorize("exportAdminData")

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
      "langfuse_url",
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
      f.langfuseUrl ?? "",
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: csvDownloadHeaders("feedback.csv"),
  })
})
