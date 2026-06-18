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
 *   breaking the CorpusPolicy `before()` admin bypass.
 *   Fetching the full row from Prisma is the only correct fix.
 */
import { auth } from "@/lib/auth"
import { bouncer, type Bouncer, AuthorizationError } from "@/lib/bouncer"
import { unauthorized, forbidden, notFound } from "@/lib/api-response"
import { UserQueries } from "@/models/users/queries"
import type { User } from "@/models/users/schema"

type AuthedHandler<C = unknown> = (
  req: Request,
  user: User,
  bouncer: Bouncer,
  ctx: C,
) => Promise<Response>

export function withAuth<C = unknown>(handler: AuthedHandler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const session = await auth.api.getSession({ headers: req.headers })
    if (!session) return unauthorized()

    // Refetch the full Prisma User to ensure all application fields (role,
    // etc.) are present — better-auth session.user only carries BaseUser.
    const user = await UserQueries.get(session.user.id)
    if (!user) return notFound("Utilisateur introuvable")

    try {
      return await handler(req, user, bouncer(user), ctx)
    } catch (e) {
      if (e instanceof AuthorizationError) return forbidden()
      throw e
    }
  }
}
