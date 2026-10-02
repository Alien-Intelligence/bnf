import { z } from "zod"
import { routing } from "@/i18n/routing"
import { LOGIN_METHOD, SIGNED_OUT_NOTICE, type SsoLogout } from "./schema"

// Sign-in and sign-up schemas are used client-side (react-hook-form + Zod)
// to validate form input before POSTing to better-auth's handler endpoints.
// Better-auth owns the server-side validation for those routes.

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})
export type SignInInput = z.infer<typeof signInSchema>

export const signUpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})
export type SignUpInput = z.infer<typeof signUpSchema>

// --- sign-out -------------------------------------------------------------
// POST /api/sign-out (app/api/sign-out/route.ts). The client sends its UI
// locale so the server can build a locale-correct sign-in URL — the route
// handler has no request locale of its own.

export const signOutSchema = z.object({ locale: z.enum(routing.locales) })
export type SignOutInput = z.infer<typeof signOutSchema>

/** What the browser must load next: an in-app sign-in URL, or Authentik's
 *  end-session URL when the SSO session is being ended too. */
export type SignOutResult = { redirectTo: string; ssoLogout: SsoLogout }

/** `session.login_method` as stored. An unknown value is a corrupt row, so
 *  parsing it throws rather than guessing a method. */
export const loginMethodSchema = z.enum([LOGIN_METHOD.EMAIL, LOGIN_METHOD.AUTHENTIK])

/** `?signedOut=` on the sign-in page. */
export const signedOutNoticeSchema = z.enum([
  SIGNED_OUT_NOTICE.DONE,
  SIGNED_OUT_NOTICE.SSO_UNAVAILABLE,
])
