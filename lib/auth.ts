import "server-only"
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
