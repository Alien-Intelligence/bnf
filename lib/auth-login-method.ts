// lib/auth-login-method.ts
// Which login method a better-auth endpoint path stands for. Called from the
// session.create.before hook in lib/auth.ts to stamp `session.login_method`,
// so sign-out can tell an Authentik session from an email/password one for
// the SAME user (account linking is on, so one user may hold both accounts).
//
// Mirrors better-auth's own last-login-method resolver
// (dist/plugins/last-login-method/index.mjs), restricted to the endpoints
// this app exposes. That plugin records the method per USER, which cannot
// answer "how was THIS session opened"; hence this per-session copy.
//
// Pure: no `server-only`, unit-tested in auth-login-method.test.ts.

import { OAUTH_PROVIDER_ID } from "@/lib/constants"
import { LOGIN_METHOD } from "@/models/users/schema"
import type { LoginMethod } from "@/models/users/types"

const OAUTH_CALLBACK_PREFIX = "/oauth2/callback/"
const EMAIL_PATHS: ReadonlySet<string> = new Set(["/sign-in/email", "/sign-up/email"])

/**
 * `null` is a defined answer, not a failure: a session created by an endpoint
 * the app does not expose (say `/change-password`), or with no endpoint
 * context at all, follows the legacy rule in lib/auth-sso.ts
 * (`shouldEndSsoSession`: end the SSO session iff an Authentik account exists).
 */
export function loginMethodFromAuthPath(
  path: string | undefined,
  providerId: string | undefined,
): LoginMethod | null {
  if (path === undefined) return null
  if (path.startsWith(OAUTH_CALLBACK_PREFIX)) {
    return providerId === OAUTH_PROVIDER_ID ? LOGIN_METHOD.AUTHENTIK : null
  }
  if (EMAIL_PATHS.has(path)) return LOGIN_METHOD.EMAIL
  return null
}
