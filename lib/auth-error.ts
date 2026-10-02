// lib/auth-error.ts
// Reading better-auth's refusal on the sign-in and sign-up forms. Its error
// body is JSON `{ code, message }`; the forms only need to know whether the
// code is one they explain (bad credentials, email taken) or anything else
// (the generic failure). A body that is not that shape is reported, not
// swallowed: the form says the generic sentence and the console has why.
//
// Client-safe and pure apart from the body read.

import { z } from "zod"
import { BETTER_AUTH_ERROR } from "@/lib/constants"

const betterAuthErrorBodySchema = z.object({ code: z.string() })

/** The better-auth error code of a refused auth request, or null if it has none. */
export async function betterAuthErrorCode(res: Response): Promise<string | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    console.error(`[auth] ${res.status} answer is not JSON`, e)
    return null
  }
  const parsed = betterAuthErrorBodySchema.safeParse(body)
  if (!parsed.success) {
    console.error(`[auth] ${res.status} answer has no error code`, body)
    return null
  }
  return parsed.data.code
}

export const INVALID_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  BETTER_AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD,
  BETTER_AUTH_ERROR.INVALID_PASSWORD,
  BETTER_AUTH_ERROR.USER_NOT_FOUND,
])

export const EMAIL_TAKEN_CODES: ReadonlySet<string> = new Set([
  BETTER_AUTH_ERROR.USER_ALREADY_EXISTS,
  BETTER_AUTH_ERROR.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL,
  BETTER_AUTH_ERROR.EMAIL_ALREADY_EXISTS,
])
