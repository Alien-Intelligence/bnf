/**
 * GET /api/admin/accounts/export
 *
 * Streams a CSV of every account with its per-account activity totals.
 * Admin-only (UserPolicy.exportAdminData) — same aggregation as /api/admin/accounts.
 */
import { withAuth } from "@/app/api/_middleware"
import { csvDownloadHeaders } from "@/lib/constants"
import { toCsv } from "@/lib/csv"
import { UserPolicy } from "@/models/users/policy"
import { UserQueries } from "@/models/users/queries"

export const GET = withAuth(async (_req, _user, bouncer) => {
  await bouncer.with(UserPolicy).authorize("exportAdminData")

  const accounts = await UserQueries.listWithAdminStats()

  const csv = toCsv(
    [
      "user_id",
      "name",
      "email",
      "role",
      "created_at",
      "projects",
      "sessions",
      "messages",
      "notes",
      "feedback_given",
      "tokens_in",
      "tokens_out",
      "last_active_at",
    ],
    accounts.map((a) => [
      a.id,
      a.name,
      a.email,
      a.role,
      a.createdAt,
      a.projectCount,
      a.sessionCount,
      a.messageCount,
      a.noteCount,
      a.feedbackGiven,
      a.tokensIn,
      a.tokensOut,
      a.lastActiveAt ?? "",
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: csvDownloadHeaders("accounts.csv"),
  })
})
