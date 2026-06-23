import "server-only"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { genericOAuth } from "better-auth/plugins"
import { prisma } from "./db"
import { env, ssoEnabled } from "./env"
import { OAUTH_PROVIDER_ID } from "./constants"

// Alien Auth (Authentik) SSO via Better Auth's genericOAuth plugin. Only wired
// up when the AUTHENTIK_* credentials are present (ssoEnabled) — otherwise the
// app runs in email/password-only mode. BnF is served at root (no Next.js
// basePath), so Better Auth derives the redirect_uri per request as
// `${origin}/api/auth/oauth2/callback/authentik` with no URL rewriting.
const oauthPlugins = ssoEnabled
  ? [
      genericOAuth({
        config: [
          {
            providerId: OAUTH_PROVIDER_ID,
            // Non-null assertions are safe: ssoEnabled is true only when all
            // three are set (see lib/env.ts).
            clientId: env.AUTHENTIK_CLIENT_ID!,
            clientSecret: env.AUTHENTIK_CLIENT_SECRET!,
            discoveryUrl: `${env.AUTHENTIK_BASE_URL}/application/o/${env.AUTHENTIK_APP_SLUG}/.well-known/openid-configuration`,
            scopes: ["openid", "email", "profile", "offline_access"],
            accessType: "offline",
            prompt: "consent",
          },
        ],
      }),
    ]
  : []

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Link an Authentik sign-in to an existing email/password user sharing the
  // same verified email instead of creating a duplicate account.
  account: { accountLinking: { enabled: true } },
  plugins: oauthPlugins,
})
