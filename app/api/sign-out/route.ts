/**
 * POST /api/sign-out — end the caller's session and, for an SSO session, send
 * the browser through Authentik's RP-initiated logout.
 *
 * withAuth → parseBody → UserService.signOut → ok<SignOutResult> with the
 * cookie-expiring Set-Cookie lines. No policy: the resource is the
 * authenticated session itself, so withAuth IS the authorization (the
 * documented exemption in playbook/api-layers.md).
 *
 * Why not better-auth's own /api/auth/sign-out: it ends the better-auth session
 * only. The Authentik session survives it, and the client cannot know whether
 * it needs the Authentik hop.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, unauthorized } from "@/lib/api-response"
import { SignOutSessionGoneError, UserService } from "@/models/users/service"
import { signOutRequestSchema, type SignOutResult } from "@/models/users/types"

export const POST = withAuth(async (req, user, _bouncer, _ctx, session) => {
  const parsed = await parseBody(req, signOutRequestSchema)
  if (parsed instanceof Response) return parsed

  try {
    const { result, setCookie } = await UserService.signOut(user, session, parsed.locale)
    const headers = new Headers()
    for (const line of setCookie) headers.append("set-cookie", line)
    return ok<SignOutResult>(result, { headers })
  } catch (e) {
    if (e instanceof SignOutSessionGoneError) return unauthorized()
    throw e
  }
})
