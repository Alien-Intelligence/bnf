/**
 * GET /api/admin/usage/export
 *
 * Streams a CSV file of per-project token usage (all-time + last-7-days).
 * Admin-only (UserPolicy.exportAdminData), same aggregation window as
 * /api/admin/usage.
 */
import { withAuth } from "@/app/api/_middleware"
import { csvDownloadHeaders } from "@/lib/constants"
import { toCsv } from "@/lib/csv"
import { MessageService } from "@/models/messages/service"
import { UserPolicy } from "@/models/users/policy"

export const GET = withAuth(async (_req, _user, bouncer) => {
  await bouncer.with(UserPolicy).authorize("exportAdminData")

  const projects = await MessageService.projectUsageTotals(new Date())

  const csv = toCsv(
    [
      "project_id",
      "project_name",
      "owner_id",
      "owner_email",
      "tokens_in",
      "tokens_out",
      "message_count",
      "last_week_tokens_in",
      "last_week_tokens_out",
    ],
    projects.map((p) => [
      p.projectId,
      p.projectName,
      p.ownerId,
      p.ownerEmail,
      p.tokensIn,
      p.tokensOut,
      p.messageCount,
      p.windowTokensIn,
      p.windowTokensOut,
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: csvDownloadHeaders("usage.csv"),
  })
})
