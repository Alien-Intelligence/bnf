import "server-only"

// Better-auth owns sign-up, sign-in and password reset. This service owns the
// one user mutation the app adds on top: deciding, at sign-out, whether the
// Alien Auth (Authentik) session has to end too.

import { authentik } from "@/lib/env"
import { OAUTH_PROVIDER_ID } from "@/lib/constants"
import { loginMethodSchema } from "@/lib/auth-login-method"
import {
  OidcDiscoveryError,
  loadAuthentikDiscovery,
  shouldEndSsoSession,
  type SsoSignOutDecision,
} from "@/lib/auth-sso"
import { UserQueries } from "./queries"
import { SSO_LOGOUT, type AuthSessionRow, type PolicyUser } from "./schema"

export class UserService {
  /**
   * What sign-out must do about the Authentik session, for this user's
   * session as withAuth resolved it (authenticated and authorized by the
   * route: UserPolicy.signOut).
   *
   * - SSO not configured, or an email/password session: nothing to end.
   * - An Authentik session (or a legacy row whose user has an Authentik
   *   account — lib/auth-sso.ts shouldEndSsoSession): `initiated`, with the
   *   discovery document and the stored id_token.
   * - Authentik's discovery cannot be obtained (OidcDiscoveryError only):
   *   `unavailable`. The route still ends the app session and the user is
   *   told the Alien session stayed open — a tracked partial failure, logged
   *   and surfaced. Any other error is a bug and propagates.
   *
   * It does not end the app session itself: that is better-auth's cookie and
   * row, ended by the route through lib/auth.ts endAppSession once this
   * decision is made.
   */
  static async signOut(
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
        "[sign-out] Authentik discovery unavailable; app session will end, SSO session left open",
        e,
      )
      return { ssoLogout: SSO_LOGOUT.UNAVAILABLE }
    }
  }
}
