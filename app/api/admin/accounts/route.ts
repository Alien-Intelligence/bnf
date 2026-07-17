/**
 * GET /api/admin/accounts
 *
 * Every account with its per-account activity totals, for the admin console's
 * Accounts tab. Admin-only — flat role gate enforced inline (see
 * /api/admin/usage). The aggregation itself lives in UserQueries so the CSV
 * export route reuses exactly the same numbers.
 *
 * Response shape: AdminAccountsResponse
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden, ok } from "@/lib/api-response"
import { UserQueries } from "@/models/users/queries"
import type { AdminAccountStat } from "@/models/users/schema"

export type AdminAccountsResponse = {
  accounts: AdminAccountStat[]
}

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const accounts = await UserQueries.listWithAdminStats()
  return ok<AdminAccountsResponse>({ accounts })
})
