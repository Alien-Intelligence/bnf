import "server-only"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { auth } from "./auth"
import { prisma } from "./db"
import { redirect } from "@/i18n/navigation"
import { GroupQueries } from "@/models/groups/queries"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"

/**
 * Resolves the signed-in user as a PolicyUser — the User row plus the ids of
 * the groups they belong to — so server pages can call the same
 * lib/authz/project-access.ts predicates the API routes use.
 */
export async function requireSessionUser(nextPath?: string): Promise<PolicyUser> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    const next = nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""
    return redirect({ href: `/sign-in${next}`, locale: "fr" })
  }

  const [row, groupIds] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id } }),
    GroupQueries.groupIdsForUser(session.user.id),
  ])
  if (!row) {
    return redirect({ href: "/sign-in", locale: "fr" })
  }

  return { ...row, groupIds }
}

/**
 * Like requireSessionUser, but also asserts the user has the "admin" role.
 * Non-admins get a 404 — consistent with how projects/[id] hides resources
 * for non-members rather than serving a visible 403.
 */
export async function requireAdminUser(nextPath?: string): Promise<PolicyUser> {
  const user = await requireSessionUser(nextPath)
  if (user.role !== USER_ROLE.ADMIN) {
    notFound()
  }
  return user
}
