/**
 * POST /api/sign-out — end the caller's session and, for an SSO session, send
 * the browser through Authentik's RP-initiated logout.
 *
 * withAuth → parseBody → UserPolicy.signOut(session) → UserService.signOut
 * (the SSO decision) → endAppSession (better-auth deletes the row and expires
 * its cookies) → ok<SignOutResult>. The decision runs first: if it fails, the
 * session is still live and the client can retry.
 *
 * Why not better-auth's own /api/auth/sign-out: it ends the better-auth session
 * only. The Authentik session survives it, and the client cannot know whether
 * it needs the Authentik hop.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok } from "@/lib/api-response"
import { endAppSession } from "@/lib/auth"
import { signOutRequestSchema } from "@/lib/auth-redirect"
import { signOutRedirect } from "@/lib/auth-sso"
import { signedOutPath } from "@/lib/auth-sign-out"
import { env } from "@/lib/env"
import { UserPolicy } from "@/models/users/policy"
import { UserService } from "@/models/users/service"
import type { SignOutResult } from "@/models/users/schema"

export const POST = withAuth(async (req, user, bouncer, _ctx, session) => {
  const parsed = await parseBody(req, signOutRequestSchema)
  if (parsed instanceof Response) return parsed

  await bouncer.with(UserPolicy).authorize("signOut", session)

  const decision = await UserService.signOut(user, session)
  const setCookie = await endAppSession(req.headers)

  const headers = new Headers()
  for (const line of setCookie) headers.append("set-cookie", line)
  return ok<SignOutResult>(
    {
      ssoLogout: decision.ssoLogout,
      redirectTo: signOutRedirect(decision, {
        signedOutPath: (notice) => signedOutPath(notice, parsed.locale),
        appUrl: env.APP_URL,
      }),
    },
    { headers },
  )
})
