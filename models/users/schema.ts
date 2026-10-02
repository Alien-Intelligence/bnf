// models/users/schema.ts
// Better-auth owns the User table and all mutations.
// This file re-exports the Prisma-generated type so business code never
// imports directly from @/lib/generated/prisma/client.

import {
  type Prisma,
  type Session as PrismaSession,
  type User as PrismaUser,
} from "@/lib/generated/prisma/client"

export type User = PrismaUser

export const USER_ROLE = {
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
} as const

export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE]

/**
 * How a session was opened — stored on `session.login_method` by the
 * better-auth session.create hook (lib/auth.ts → lib/auth-login-method.ts).
 * The SSO value is the OAuth provider id (lib/constants.ts OAUTH_PROVIDER_ID
 * is defined FROM this), so the column reads the same as
 * `account.provider_id`. A row may also be `null`: opened before the column
 * existed, or by an endpoint the app does not expose; sign-out then falls back
 * to "has an Authentik account" (lib/auth-sso.ts shouldEndSsoSession). Zod
 * enum and type: ./types.ts.
 */
export const LOGIN_METHOD = { EMAIL: "email", AUTHENTIK: "authentik" } as const

/**
 * The `?signedOut=` values: how the previous session ended, so the sign-in
 * page can say so. Written by UserService.signOut, read by the sign-in page.
 * Zod enum and type: ./types.ts.
 */
export const SIGNED_OUT_NOTICE = { DONE: "done", SSO_UNAVAILABLE: "sso-unavailable" } as const

/**
 * The one column sign-out needs from an OAuth account row: the id_token
 * better-auth stored at the last SSO sign-in, passed to Authentik as
 * `id_token_hint`. Query shape, so it lives here beside the others.
 */
export const accountIdToken = {
  select: { idToken: true },
} satisfies Prisma.AccountDefaultArgs
export type AccountIdToken = Prisma.AccountGetPayload<typeof accountIdToken>

/** What sign-out did about the Authentik session — reported to the client. */
export const SSO_LOGOUT = {
  /** The browser is sent to Authentik's end-session endpoint. */
  INITIATED: "initiated",
  /** An email/password session, or SSO is not configured: nothing to end. */
  NOT_APPLICABLE: "not_applicable",
  /** Authentik's discovery could not be fetched: app session ended, SSO session left open. */
  UNAVAILABLE: "unavailable",
} as const
export type SsoLogout = (typeof SSO_LOGOUT)[keyof typeof SSO_LOGOUT]

/**
 * The better-auth session row a signed-in request carries, as withAuth hands
 * it over: the owner and how it was opened (`login_method`, possibly absent on
 * a row better-auth built before the column existed).
 */
export type AuthSessionRow = Pick<PrismaSession, "id" | "userId"> &
  Partial<Pick<PrismaSession, "loginMethod">>

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
  /** The stored role, as Prisma types it (a String column); the accounts table
   *  validates it with userRoleSchema before choosing a label. */
  role: User["role"]
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
