import { z } from "zod"
import { APP_LOCALES } from "@/lib/constants"
import {
  LOGIN_METHOD,
  SIGNED_OUT_NOTICE,
  USER_ROLE,
  type SsoLogout,
} from "./schema"

/** Shortest password the sign-in and sign-up forms accept (better-auth's default). */
const PASSWORD_MIN_LENGTH = 8

// Sign-in and sign-up schemas are used client-side (react-hook-form + Zod)
// to validate form input before POSTing to better-auth's handler endpoints.
// Better-auth owns the server-side validation for those routes.

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
})
export type SignInInput = z.infer<typeof signInSchema>

export const signUpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH),
})
export type SignUpInput = z.infer<typeof signUpSchema>

// --- roles, sessions, sign-out ---------------------------------------------

/** `user.role` as stored; validate before trusting a raw value. */
export const userRoleSchema = z.enum(USER_ROLE)

/** `session.login_method` as stored. An unknown value is a corrupt row, so
 *  parsing it throws rather than guessing a method. */
export const loginMethodSchema = z.enum(LOGIN_METHOD)
export type LoginMethod = z.infer<typeof loginMethodSchema>

/** `?signedOut=` on the sign-in page. */
export const signedOutNoticeSchema = z.enum(SIGNED_OUT_NOTICE)
export type SignedOutNotice = z.infer<typeof signedOutNoticeSchema>

/** POST /api/sign-out body: the UI locale the sign-in URLs are built in (a
 *  route handler has no request locale of its own). */
export const signOutRequestSchema = z.object({ locale: z.enum(APP_LOCALES) })
export type SignOutRequest = z.infer<typeof signOutRequestSchema>

/** What POST /api/sign-out answers: the URL the browser must load next (the
 *  sign-in page, or Authentik's end-session endpoint) and what happened to the
 *  Authentik session. */
export type SignOutResult = { redirectTo: string; ssoLogout: SsoLogout }
