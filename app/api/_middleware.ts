/**
 * withAuth — authentication + authorization wrapper for route handlers.
 *
 * Usage:
 *   export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => { … })
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
import { auth } from "@/lib/auth"
import { bouncer, type Bouncer, AuthorizationError } from "@/lib/bouncer"
import { badRequest, unauthorized, forbidden, notFound } from "@/lib/api-response"
import { FilterValueError } from "@/lib/filters"
import { UserQueries } from "@/models/users/queries"
import { GroupQueries } from "@/models/groups/queries"
import type { PolicyUser } from "@/models/users/schema"

type AuthedHandler<C = unknown> = (
  req: Request,
  user: PolicyUser,
  bouncer: Bouncer,
  ctx: C,
) => Promise<Response>

/**
 * The ONE assembly of a request's PolicyUser: the session, then the full
 * Prisma User (all application fields — better-auth session.user only carries
 * BaseUser) and the user's group ids, resolved once so policies stay I/O-free
 * (every project-access decision reads `groupIds` off the PolicyUser).
 * `no_session` / `no_user` say why there is none; the caller decides the
 * response. withAuth uses it, and so does the chat route's tool-context
 * callback, which the SDK hands a bare Request (the documented exemption in
 * app/api/sessions/[sid]/messages/route.ts).
 */
export async function resolvePolicyUser(
  req: Request,
): Promise<{ ok: true; user: PolicyUser } | { ok: false; reason: "no_session" | "no_user" }> {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session) return { ok: false, reason: "no_session" }
  const [row, groupIds] = await Promise.all([
    UserQueries.get(session.user.id),
    GroupQueries.groupIdsForUser(session.user.id),
  ])
  if (!row) return { ok: false, reason: "no_user" }
  return { ok: true, user: { ...row, groupIds } }
}

export function withAuth<C = unknown>(handler: AuthedHandler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const resolved = await resolvePolicyUser(req)
    if (!resolved.ok) {
      return resolved.reason === "no_session" ? unauthorized() : notFound("Utilisateur introuvable")
    }
    const user = resolved.user

    try {
      return await handler(req, user, bouncer(user), ctx)
    } catch (e) {
      if (e instanceof AuthorizationError) return forbidden()
      // A filter value the data refuses (a language the store does not hold):
      // the caller's mistake, named — never a 500.
      if (e instanceof FilterValueError) return badRequest(e.message)
      throw e
    }
  }
}
