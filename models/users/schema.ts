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
 * What POST /api/sign-out answers: the URL the browser must load next (the
 * sign-in page, or Authentik's end-session endpoint) and what happened to the
 * Authentik session.
 */
export type SignOutResult = { redirectTo: string; ssoLogout: SsoLogout }

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
