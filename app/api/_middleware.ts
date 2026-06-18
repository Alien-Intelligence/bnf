/**
 * withAuth — authentication + authorization wrapper for route handlers.
 *
 * Usage:
 *   export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => { … })
 *
 * This file is colocated in app/api/ as a private utility (underscore prefix).
 * Next.js only routes files named route.ts/page.tsx — this file is never
 * exposed as an HTTP endpoint.
 */
import { auth } from "@/lib/auth"
import { bouncer, type Bouncer, AuthorizationError } from "@/lib/bouncer"
import { unauthorized, forbidden } from "@/lib/api-response"
import type { User } from "@/lib/generated/prisma/client"

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
    try {
      return await handler(
        req,
        session.user as User,
        bouncer(session.user as User),
        ctx,
      )
    } catch (e) {
      if (e instanceof AuthorizationError) return forbidden()
      throw e
    }
  }
}
