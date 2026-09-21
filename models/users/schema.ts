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
