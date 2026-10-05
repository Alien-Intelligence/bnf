import "server-only"

// Better-auth owns sign-up, sign-in and password reset. This service owns the
// one user mutation the app adds on top: sign-out, which ends the app session
// AND decides whether the Alien Auth (Authentik) session has to end too.

import { prisma } from "@/lib/db"
import { authentik, env } from "@/lib/env"
import { OAUTH_PROVIDER_ID } from "@/lib/constants"
import { sessionCookieExpiry } from "@/lib/auth"
import {
  OidcDiscoveryError,
  loadAuthentikDiscovery,
  shouldEndSsoSession,
  signOutRedirect,
  type SsoSignOutDecision,
} from "@/lib/auth-sso"
import { signedOutPath } from "@/lib/auth-sign-out"
import type { AppLocale } from "@/i18n/routing"
import { UserQueries } from "./queries"
import { SSO_LOGOUT, type AuthSessionRow, type PolicyUser } from "./schema"
import { loginMethodSchema, type SignOutResult } from "./types"

/**
 * The session withAuth authenticated no longer exists when sign-out tries to
 * delete it: another tab (or expiry) ended it in between. The route answers
 * 401, which the client treats as "already signed out".
 */
export class SignOutSessionGoneError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} was already gone at sign-out`)
    this.name = "SignOutSessionGoneError"
  }
}

export class UserService {
  /**
   * End THIS session — the one withAuth authenticated, deleted by id and
   * checked deleted — and return what the browser must do next, with the
   * Set-Cookie lines that expire the auth cookies.
   *
   * The Authentik decision is made first, while the session row still says
   * how it was opened: SSO not configured or an email/password session →
   * back to sign-in; an Authentik session (or a legacy row whose user has an
   * Authentik account — shouldEndSsoSession) → Authentik's RP-initiated
   * logout URL; discovery unobtainable (OidcDiscoveryError only) → the app
   * session still ends and the sign-in page says the Alien session stayed open
   * (logged, surfaced). Any other error propagates and the session survives,
   * so the user can retry.
   */
  static async signOut(
    user: PolicyUser,
    session: AuthSessionRow,
    locale: AppLocale,
  ): Promise<{ result: SignOutResult; setCookie: string[] }> {
    const decision = await UserService.ssoDecision(user, session)

    const { count } = await prisma.session.deleteMany({ where: { id: session.id } })
    if (count !== 1) throw new SignOutSessionGoneError(session.id)

    const redirectTo = signOutRedirect(decision, {
      signedOutPath: (notice) => signedOutPath(notice, locale),
      appUrl: env.APP_URL,
    })
    return {
      result: { redirectTo, ssoLogout: decision.ssoLogout },
      setCookie: await sessionCookieExpiry(),
    }
  }

  private static async ssoDecision(
    user: PolicyUser,
    session: AuthSessionRow,
  ): Promise<SsoSignOutDecision> {
    if (!authentik) return { ssoLogout: SSO_LOGOUT.NOT_APPLICABLE }

    // An unknown stored value throws: a corrupt row, not a guess.
    const loginMethod = loginMethodSchema.nullable().parse(session.loginMethod ?? null)
    const account = await UserQueries.oauthAccount(user.id, OAUTH_PROVIDER_ID)
    const endSso = shouldEndSsoSession({
      ssoConfigured: true,
      loginMethod,
      hasAuthentikAccount: account !== null,
    })
    if (!endSso) return { ssoLogout: SSO_LOGOUT.NOT_APPLICABLE }

    try {
      const discovery = await loadAuthentikDiscovery(authentik)
      return {
        ssoLogout: SSO_LOGOUT.INITIATED,
        discovery,
        idTokenHint: account?.idToken ?? null,
        clientId: authentik.clientId,
      }
    } catch (e) {
      if (!(e instanceof OidcDiscoveryError)) throw e
      console.error(
        "[sign-out] Authentik discovery unavailable; app session ends, SSO session left open",
        e,
      )
      return { ssoLogout: SSO_LOGOUT.UNAVAILABLE }
    }
  }
}
