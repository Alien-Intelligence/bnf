import "server-only"
import { NextResponse } from "next/server"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { genericOAuth } from "better-auth/plugins"
import { prisma } from "./db"
import { authentik, env } from "./env"
import { OAUTH_PROVIDER_ID } from "./constants"
import { loginMethodFromAuthPath } from "./auth-login-method"
import { authentikDiscoveryUrl } from "./auth-sso"

// Alien Auth (Authentik) SSO via Better Auth's genericOAuth plugin. Only wired
// up when the AUTHENTIK_* credentials are present (lib/env.ts `authentik`) —
// otherwise the app runs in email/password-only mode. BnF is served at root
// (no Next.js basePath), so Better Auth derives the redirect_uri per request
// as `${origin}/api/auth/oauth2/callback/authentik` with no URL rewriting.
const oauthPlugins = authentik
  ? [
      genericOAuth({
        config: [
          {
            providerId: OAUTH_PROVIDER_ID,
            clientId: authentik.clientId,
            clientSecret: authentik.clientSecret,
            discoveryUrl: authentikDiscoveryUrl(authentik),
            scopes: ["openid", "email", "profile", "offline_access"],
            accessType: "offline",
            prompt: "consent",
          },
        ],
      }),
    ]
  : []

/** The hook context's `params` is `Record<string, any>`; only a string is a provider id. */
function providerIdParam(params: Record<string, unknown> | undefined): string | undefined {
  const value = params?.["providerId"]
  return typeof value === "string" ? value : undefined
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Link an Authentik sign-in to an existing email/password user sharing the
  // same verified email instead of creating a duplicate account.
  account: { accountLinking: { enabled: true } },
  session: {
    // `session.login_method` (prisma/schema.prisma). Never client-settable
    // (`input: false`): the hook below is its only writer.
    additionalFields: {
      loginMethod: { type: "string", required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Stamp how the session was opened from the endpoint that opened it,
        // so sign-out can tell an Authentik session from an email/password one
        // for the same user (lib/auth-sso.ts shouldEndSsoSession).
        before: async (session, ctx) => ({
          data: {
            ...session,
            loginMethod: loginMethodFromAuthPath(ctx?.path, providerIdParam(ctx?.params)),
          },
        }),
      },
    },
  },
  plugins: oauthPlugins,
})

/** A signed-in request's session as better-auth resolves it. */
export type AuthSession = typeof auth.$Infer.Session

/**
 * The Set-Cookie lines that expire every auth cookie better-auth set for a
 * session: the session token, the session-data cache and the dont-remember
 * marker. Names and attributes (secure prefix, path, SameSite, HttpOnly) come
 * from better-auth's own cookie configuration, so they always match what it
 * issued; Next's response-cookie serializer writes them.
 *
 * Used by UserService.signOut after it has deleted the session row itself:
 * better-auth's cookie-based sign-out would re-resolve the session from the
 * cookie and swallow a failed delete.
 */
export async function sessionCookieExpiry(): Promise<string[]> {
  const { authCookies } = await auth.$context
  const res = new NextResponse(null)
  for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken]) {
    const { sameSite, ...attributes } = cookie.attributes
    res.cookies.set(cookie.name, "", {
      ...attributes,
      sameSite: sameSite === undefined ? undefined : toSameSite(sameSite),
      maxAge: 0,
    })
  }
  return res.headers.getSetCookie()
}

type BetterAuthSameSite = "Strict" | "Lax" | "None" | "strict" | "lax" | "none"
const SAME_SITE: Record<BetterAuthSameSite, "strict" | "lax" | "none"> = {
  Strict: "strict",
  strict: "strict",
  Lax: "lax",
  lax: "lax",
  None: "none",
  none: "none",
}
function toSameSite(value: BetterAuthSameSite): "strict" | "lax" | "none" {
  return SAME_SITE[value]
}

/**
 * A live session whose user row does not exist. The session table's foreign
 * key cascades on user deletion, so this is a data-integrity fault, not a
 * signed-out visitor: raised (500 + log) by withAuth and findSessionUser alike,
 * never rendered as "please sign in".
 */
export class OrphanedSessionError extends Error {
  constructor(readonly userId: string) {
    super(`Live session for user ${userId}, who has no user row`)
    this.name = "OrphanedSessionError"
  }
}
