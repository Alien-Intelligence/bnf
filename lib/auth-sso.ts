import "server-only"

// lib/auth-sso.ts
// The Authentik half of sign-out: RP-initiated logout (OIDC RP-Initiated
// Logout 1.0 §2). better-auth ends only ITS session; the Authentik session
// survives, so « Se connecter avec Alien » would sign the user straight back
// in. UserService.signOut decides with `shouldEndSsoSession` and fetches the
// end-session endpoint from the discovery document (never a guessed path);
// the route turns that decision into the URL the browser loads
// (`signOutRedirect`).
//
// Pure except `loadAuthentikDiscovery`, which takes an injectable `fetchImpl`
// so the memo and failure paths are unit-tested without a network.

import { z } from "zod"
import type { AuthentikConfig } from "@/lib/env"
import { OIDC_DISCOVERY_TIMEOUT_MS } from "@/lib/constants"
import { LOGIN_METHOD, SIGNED_OUT_NOTICE, SSO_LOGOUT } from "@/models/users/schema"
import type { LoginMethod, SignedOutNotice } from "@/models/users/types"

/**
 * Authentik's discovery document could not be obtained: the request failed or
 * timed out, the server answered non-2xx, or the body is not a usable
 * document. The ONE failure sign-out tolerates (the app session still ends and
 * the user is told); anything else is a bug and propagates.
 */
export class OidcDiscoveryError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = "OidcDiscoveryError"
  }
}

/** The application's well-known document. Also what the OAuth plugin uses. */
export function authentikDiscoveryUrl(cfg: Pick<AuthentikConfig, "baseUrl" | "appSlug">): string {
  return `${cfg.baseUrl}/application/o/${cfg.appSlug}/.well-known/openid-configuration`
}

/**
 * Only the two fields sign-out needs. A document without
 * `end_session_endpoint` is a parse error: we never guess the path.
 */
export const oidcDiscoverySchema = z.object({
  issuer: z.string().url(),
  end_session_endpoint: z.string().url(),
})
export type OidcDiscovery = z.infer<typeof oidcDiscoverySchema>

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

// Memoized per discovery URL for the process lifetime once it SUCCEEDS; a
// rejected fetch is dropped so the next sign-out tries again (a transient
// outage must not poison every later sign-out). The document is static per
// Authentik application.
const discoveryMemo = new Map<string, Promise<OidcDiscovery>>()

export function loadAuthentikDiscovery(
  cfg: Pick<AuthentikConfig, "baseUrl" | "appSlug">,
  fetchImpl: FetchImpl = fetch,
): Promise<OidcDiscovery> {
  const url = authentikDiscoveryUrl(cfg)
  const cached = discoveryMemo.get(url)
  if (cached) return cached

  const pending = fetchDiscovery(url, fetchImpl)
  discoveryMemo.set(url, pending)
  pending.catch(() => {
    // Only forget our own entry: a newer attempt may already have replaced it.
    if (discoveryMemo.get(url) === pending) discoveryMemo.delete(url)
  })
  return pending
}

async function fetchDiscovery(url: string, fetchImpl: FetchImpl): Promise<OidcDiscovery> {
  let res: Response
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(OIDC_DISCOVERY_TIMEOUT_MS) })
  } catch (e) {
    throw new OidcDiscoveryError(`OIDC discovery at ${url} failed`, { cause: e })
  }
  if (!res.ok) {
    throw new OidcDiscoveryError(`OIDC discovery at ${url} answered ${res.status}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    throw new OidcDiscoveryError(`OIDC discovery at ${url} is not JSON`, { cause: e })
  }
  const parsed = oidcDiscoverySchema.safeParse(body)
  if (!parsed.success) {
    throw new OidcDiscoveryError(`OIDC discovery at ${url} is not usable`, { cause: parsed.error })
  }
  return parsed.data
}

/**
 * The GET form of RP-initiated logout. `id_token_hint` is a signed identity
 * assertion, not an API bearer, and the spec defines it as a query parameter.
 * `client_id` is always sent too, so the request stays valid when the hint is
 * stale (Authentik's id_token lasts about an hour; §2 asks the OP to accept an
 * expired hint).
 */
export function endSessionUrl(
  discovery: OidcDiscovery,
  params: { idTokenHint: string | null; clientId: string; postLogoutRedirectUri: string },
): string {
  const url = new URL(discovery.end_session_endpoint)
  if (params.idTokenHint !== null) url.searchParams.set("id_token_hint", params.idTokenHint)
  url.searchParams.set("client_id", params.clientId)
  url.searchParams.set("post_logout_redirect_uri", params.postLogoutRedirectUri)
  return url.toString()
}

/**
 * Whether this sign-out must also end the Authentik session.
 *
 * - SSO not configured: nothing to end.
 * - The session's recorded method decides when it is known.
 * - A legacy or unknown row (`null`) ends the SSO session iff the user has
 *   an Authentik account. The rule errs toward ending MORE sessions, the safe
 *   side for a logout.
 */
export function shouldEndSsoSession(input: {
  ssoConfigured: boolean
  loginMethod: LoginMethod | null
  hasAuthentikAccount: boolean
}): boolean {
  if (!input.ssoConfigured) return false
  if (input.loginMethod === LOGIN_METHOD.AUTHENTIK) return true
  if (input.loginMethod === LOGIN_METHOD.EMAIL) return false
  return input.hasAuthentikAccount
}

/**
 * What sign-out decided about the Authentik session (UserService.signOut).
 * `initiated` carries what the end-session URL needs; the URL itself is built
 * by `signOutRedirect`, where the UI locale is known.
 */
export type SsoSignOutDecision =
  | { ssoLogout: typeof SSO_LOGOUT.NOT_APPLICABLE }
  | { ssoLogout: typeof SSO_LOGOUT.UNAVAILABLE }
  | {
      ssoLogout: typeof SSO_LOGOUT.INITIATED
      discovery: OidcDiscovery
      idTokenHint: string | null
      clientId: string
    }

/**
 * Where the browser goes after sign-out. `signedOutPath` builds the in-app,
 * locale-prefixed sign-in path for a notice; `appUrl` makes it absolute for
 * Authentik's `post_logout_redirect_uri`.
 */
export function signOutRedirect(
  decision: SsoSignOutDecision,
  ctx: { signedOutPath: (notice: SignedOutNotice) => string; appUrl: string },
): string {
  switch (decision.ssoLogout) {
    case SSO_LOGOUT.NOT_APPLICABLE:
      return ctx.signedOutPath(SIGNED_OUT_NOTICE.DONE)
    case SSO_LOGOUT.UNAVAILABLE:
      return ctx.signedOutPath(SIGNED_OUT_NOTICE.SSO_UNAVAILABLE)
    case SSO_LOGOUT.INITIATED:
      return endSessionUrl(decision.discovery, {
        idTokenHint: decision.idTokenHint,
        clientId: decision.clientId,
        postLogoutRedirectUri: new URL(
          ctx.signedOutPath(SIGNED_OUT_NOTICE.DONE),
          ctx.appUrl,
        ).toString(),
      })
  }
}
