/**
 * GET /api/admin/accounts/export
 *
 * Streams a CSV of every account with its per-account activity totals.
 * Admin-only — same flat role gate and same aggregation as /api/admin/accounts.
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden } from "@/lib/api-response"
import { toCsv } from "@/lib/csv"
import { UserQueries } from "@/models/users/queries"

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

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
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="accounts.csv"',
      "Cache-Control": "no-store",
    },
  })
})
