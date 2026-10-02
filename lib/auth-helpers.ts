import "server-only"
import { cache } from "react"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { getLocale } from "next-intl/server"
import { auth } from "./auth"
import { redirect } from "@/i18n/navigation"
import { AUTH_QUERY, ROUTES } from "@/lib/constants"
import { GroupQueries } from "@/models/groups/queries"
import { UserQueries } from "@/models/users/queries"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"

/**
 * A live session whose user row does not exist. The session table's foreign
 * key cascades on user deletion, so this is a data-integrity fault, not a
 * signed-out visitor: it is raised, never rendered as "please sign in".
 */
export class OrphanedSessionError extends Error {
  constructor(readonly userId: string) {
    super(`Live session for user ${userId}, who has no user row`)
    this.name = "OrphanedSessionError"
  }
}

/**
 * The signed-in user as a PolicyUser — the User row plus the ids of the groups
 * they belong to — or null when there is no live session. A session without a
 * user row throws OrphanedSessionError.
 *
 * Memoized per render with React `cache`: the project layout and the page it
 * wraps both call this, and share one session + user + groups lookup. This is
 * the read half of the auth check; it never redirects, so a layout can render
 * from it without gating (Next 16 authentication guide, "Layouts and auth
 * checks").
 */
export const findSessionUser = cache(async (): Promise<PolicyUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) return null

  const [row, groupIds] = await Promise.all([
    UserQueries.get(session.user.id),
    GroupQueries.groupIdsForUser(session.user.id),
  ])
  if (!row) throw new OrphanedSessionError(session.user.id)

  return { ...row, groupIds }
})

/**
 * Resolves the signed-in user as a PolicyUser so server pages can call the
 * same lib/authz/project-access.ts predicates the API routes use. Without a
 * session it redirects to sign-in in the request's locale, carrying the page's
 * own path as `?next=` so sign-in can bring the user back.
 */
export async function requireSessionUser(nextPath?: string): Promise<PolicyUser> {
  const user = await findSessionUser()
  if (user) return user

  const locale = await getLocale()
  return redirect({
    href: nextPath
      ? { pathname: ROUTES.signIn, query: { [AUTH_QUERY.NEXT]: nextPath } }
      : ROUTES.signIn,
    locale,
  })
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
