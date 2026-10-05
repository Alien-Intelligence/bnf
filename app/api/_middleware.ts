/**
 * withAuth — authentication + authorization wrapper for route handlers.
 *
 * Usage:
 *   export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => { … })
 *
 * The fifth argument is the better-auth session row withAuth resolved the user
 * from. Almost every route ignores it; POST /api/sign-out acts on it (the
 * session IS the resource there), so nothing downstream has to resolve the
 * session a second time.
 *
 * This file is colocated in app/api/ as a private utility (underscore prefix).
 * Next.js only routes files named route.ts/page.tsx — this file is never
 * exposed as an HTTP endpoint.
 *
 * Why we refetch the user from Prisma:
 *   better-auth's session.user only carries BaseUser fields (id, email, name,
 *   image, emailVerified, createdAt, updatedAt). It does NOT include custom
 *   fields added to the User table (e.g. `role`). A bare `session.user as User`
 *   cast produces an object where `role` is `undefined` at runtime, silently
 *   breaking the admin rule inside lib/authz/project-access.ts.
 *   Fetching the full row from Prisma is the only correct fix.
 */
import { auth, OrphanedSessionError, type AuthSession } from "@/lib/auth"
import { bouncer, type Bouncer, AuthorizationError } from "@/lib/bouncer"
import { badRequest, unauthorized, forbidden } from "@/lib/api-response"
import { FilterValueError } from "@/lib/filters"
import { UserQueries } from "@/models/users/queries"
import { GroupQueries } from "@/models/groups/queries"
import type { PolicyUser } from "@/models/users/schema"

type AuthedHandler<C = unknown> = (
  req: Request,
  user: PolicyUser,
  bouncer: Bouncer,
  ctx: C,
  session: AuthSession["session"],
) => Promise<Response>

/**
 * The ONE assembly of a request's PolicyUser: the session, then the full
 * Prisma User (all application fields — better-auth session.user only carries
 * BaseUser) and the user's group ids, resolved once so policies stay I/O-free
 * (every project-access decision reads `groupIds` off the PolicyUser).
 * Returns null when there is no session; the caller decides the response.
 * A live session without its user row is a data-integrity fault (the FK
 * cascades on user deletion), not an unknown visitor: it is raised, logged, as
 * the page path does (lib/auth-helpers.ts findSessionUser). withAuth uses it,
 * and so does the chat route's tool-context callback, which the SDK hands a
 * bare Request (the documented exemption in
 * app/api/sessions/[sid]/messages/route.ts).
 */
export async function resolvePolicyUser(
  req: Request,
): Promise<{ user: PolicyUser; session: AuthSession["session"] } | null> {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session) return null
  const [row, groupIds] = await Promise.all([
    UserQueries.get(session.user.id),
    GroupQueries.groupIdsForUser(session.user.id),
  ])
  if (!row) {
    const error = new OrphanedSessionError(session.user.id)
    console.error("[resolvePolicyUser]", error)
    throw error
  }
  return { user: { ...row, groupIds }, session: session.session }
}

export function withAuth<C = unknown>(handler: AuthedHandler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const resolved = await resolvePolicyUser(req)
    if (!resolved) return unauthorized()
    const { user, session } = resolved

    try {
      return await handler(req, user, bouncer(user), ctx, session)
    } catch (e) {
      if (e instanceof AuthorizationError) return forbidden()
      // A filter value the data refuses (a language the store does not hold):
      // the caller's mistake, named — never a 500.
      if (e instanceof FilterValueError) return badRequest(e.message)
      throw e
    }
  }
}
