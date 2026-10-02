/**
 * POST /api/sign-out — end the caller's session; for an SSO session, hand
 * back Authentik's RP-initiated logout URL for the browser to load.
 *
 * Self-scoped like /api/onboarding: the only actor who can reach the resource
 * is the cookie holder withAuth resolved, so there is no resource to authorize
 * beyond that and no policy class (a `return true` policy would be a lie —
 * playbook/api-layers.md). The locale rides the body because a route handler
 * has no request locale of its own.
 *
 * Why not better-auth's own /api/auth/sign-out: it ends the better-auth session
 * only. The Authentik session survives it, and the client cannot know whether
 * it needs the Authentik hop. See plan Decision 3.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, unauthorized } from "@/lib/api-response"
import { NoActiveSessionError, UserService } from "@/models/users/service"
import { signOutSchema, type SignOutResult } from "@/models/users/types"

export const POST = withAuth(async (req) => {
  const parsed = await parseBody(req, signOutSchema)
  if (parsed instanceof Response) return parsed

  try {
    const { result, setCookie } = await UserService.signOut(req.headers, parsed)
    // Forward better-auth's cookie-clearing lines: the browser must drop the
    // session cookie with the same response that tells it where to go.
    const headers = new Headers()
    for (const line of setCookie) headers.append("set-cookie", line)
    return ok<SignOutResult>(result, { headers })
  } catch (e) {
    if (e instanceof NoActiveSessionError) return unauthorized()
    throw e
  }
})
