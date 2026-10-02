import "server-only"

// Better-auth owns sign-up, sign-in and password reset. This service owns the
// one user mutation the app adds on top: sign-out, which must also decide
// whether the Alien Auth (Authentik) session has to end.

import { getPathname } from "@/i18n/navigation"
import { auth } from "@/lib/auth"
import { authentik, env } from "@/lib/env"
import { AUTH_QUERY, ROUTES } from "@/lib/constants"
import {
  endSessionUrl,
  loadAuthentikDiscovery,
  shouldEndSsoSession,
} from "@/lib/auth-sso"
import { UserQueries } from "./queries"
import { SIGNED_OUT_NOTICE, SSO_LOGOUT, type SignedOutNotice } from "./schema"
import { loginMethodSchema, type SignOutInput, type SignOutResult } from "./types"

/**
 * The cookie holder has no live session any more. Thrown when a concurrent
 * sign-out (another tab) wins the race after withAuth resolved the user; the
 * route answers 401, which the client treats as "already signed out".
 */
export class NoActiveSessionError extends Error {
  constructor() {
    super("No active session")
    this.name = "NoActiveSessionError"
  }
}

export class UserService {
  /**
   * End the caller's session. Always deletes the better-auth session row and
   * returns the cookie-clearing Set-Cookie lines for the route to forward.
   *
   * For a session opened through Authentik (or a legacy row whose user has an
   * Authentik account — lib/auth-sso.ts shouldEndSsoSession), `redirectTo` is
   * Authentik's RP-initiated logout URL. If Authentik's discovery document
   * cannot be fetched, the app session still ends and the user is TOLD the
   * Alien session stayed open (`ssoLogout: "unavailable"`): a tracked partial
   * failure surfaced to the user, not a swallowed one.
   *
   * On the "no inline session check" rule (playbook/api-layers.md): that rule
   * keeps AUTHENTICATION in withAuth, and the route is withAuth-wrapped. Here
   * the session row IS the resource being mutated, and its `loginMethod` is
   * the fact that decides the SSO hop; withAuth hands over the user, not the
   * session, so the service reads the resource it is about to delete — the
   * same way other services load the row they act on. See plan Decision 8.
   */
  static async signOut(
    headers: Headers,
    input: SignOutInput,
  ): Promise<{ result: SignOutResult; setCookie: string[] }> {
    const current = await auth.api.getSession({ headers })
    if (!current) throw new NoActiveSessionError()

    // An unknown stored value throws: a corrupt row, not a guess.
    const loginMethod = loginMethodSchema
      .nullable()
      .parse(current.session.loginMethod ?? null)
    const account = authentik
      ? await UserQueries.authentikAccount(current.user.id)
      : null

    const signInUrl = (notice: SignedOutNotice): string =>
      getPathname({
        href: { pathname: ROUTES.signIn, query: { [AUTH_QUERY.SIGNED_OUT]: notice } },
        locale: input.locale,
      })

    let result: SignOutResult = {
      redirectTo: signInUrl(SIGNED_OUT_NOTICE.DONE),
      ssoLogout: SSO_LOGOUT.NOT_APPLICABLE,
    }

    if (
      authentik &&
      shouldEndSsoSession({
        ssoConfigured: true,
        loginMethod,
        hasAuthentikAccount: account !== null,
      })
    ) {
      try {
        const discovery = await loadAuthentikDiscovery(authentik)
        result = {
          ssoLogout: SSO_LOGOUT.INITIATED,
          redirectTo: endSessionUrl(discovery, {
            idTokenHint: account?.idToken ?? null,
            clientId: authentik.clientId,
            postLogoutRedirectUri: new URL(
              signInUrl(SIGNED_OUT_NOTICE.DONE),
              env.APP_URL,
            ).toString(),
          }),
        }
      } catch (e) {
        console.error(
          "[sign-out] Authentik discovery unavailable; app session ended, SSO session left open",
          e,
        )
        result = {
          redirectTo: signInUrl(SIGNED_OUT_NOTICE.SSO_UNAVAILABLE),
          ssoLogout: SSO_LOGOUT.UNAVAILABLE,
        }
      }
    }

    const { headers: out } = await auth.api.signOut({ headers, returnHeaders: true })
    return { result, setCookie: out.getSetCookie() }
  }
}
