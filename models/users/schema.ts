// models/users/schema.ts
// Better-auth owns the User table and all mutations.
// This file re-exports the Prisma-generated type so business code never
// imports directly from @/lib/generated/prisma/client.

import { type User as PrismaUser } from "@/lib/generated/prisma/client"

export type User = PrismaUser

export const USER_ROLE = {
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
} as const

export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE]

/**
 * How a session was opened — stored on `session.login_method` by the
 * better-auth session.create hook (lib/auth.ts, lib/auth-login-method.ts).
 * The value for SSO is the OAuth provider id (`OAUTH_PROVIDER_ID` in
 * lib/constants.ts — spelled out here because schema.ts imports nothing
 * internal; lib/auth-login-method.test.ts pins the two equal) so the column
 * reads the same as `account.provider_id`. A row may also be `null`: a session
 * opened before the column existed, or by an endpoint the app does not expose.
 * Sign-out then falls back to "has an Authentik account" (lib/auth-sso.ts
 * shouldEndSsoSession).
 */
export const LOGIN_METHOD = { EMAIL: "email", AUTHENTIK: "authentik" } as const
export type LoginMethod = (typeof LOGIN_METHOD)[keyof typeof LOGIN_METHOD]

/**
 * The acting user as every authorization predicate sees them: the User row
 * plus the ids of the groups they belong to. Resolved once per request in
 * `withAuth` (and once per render in `requireSessionUser`), never inside a
 * policy — policies do no I/O.
 *
 * This is the type `bouncer()` and every `models/*\/policy.ts` constructor
 * take. Passing a bare `User` fails to compile, which is what makes the
 * Phase-0 predicate collapse exhaustive.
 */
export type PolicyUser = User & { groupIds: string[] }

/**
 * Per-account aggregate row for the admin console. A read-only DTO — not the
 * User entity. Dates are ISO strings because this shape crosses to the client
 * as JSON; typing them as strings keeps the hook honest.
 */
export type AdminAccountStat = {
  id: string
  name: string
  email: string
  role: string
  createdAt: string
  projectCount: number
  sessionCount: number
  messageCount: number
  noteCount: number
  feedbackGiven: number
  tokensIn: number
  tokensOut: number
  lastActiveAt: string | null
}
