"use client"

// hooks/api/users.ts
// TanStack Query hooks for the users model. Today: sign-out.
// All HTTP calls go through apiFetch — never raw fetch().

import { useMutation } from "@tanstack/react-query"
import { useLocale } from "next-intl"
import { getPathname } from "@/i18n/navigation"
import { apiFetch, readError } from "@/lib/api-fetch"
import { ROUTES } from "@/lib/constants"
import { SSO_LOGOUT } from "@/models/users/schema"
import { signOutSchema, type SignOutResult } from "@/models/users/types"

const SIGN_OUT_ENDPOINT = "/api/sign-out"

/**
 * POST /api/sign-out. The result says where the browser must go next: the
 * sign-in page, or Authentik's end-session URL for an SSO session.
 *
 * No `onSuccess` cache work and no query key: the caller leaves with a full
 * document navigation (ButtonAuthSignOut), which discards the TanStack cache
 * and the Next Client Cache together. Nothing survives to be invalidated.
 */
export function useSignOut() {
  const locale = useLocale()
  return useMutation<SignOutResult, Error, void>({
    mutationFn: async () => {
      // useLocale() is typed as a bare string; the schema is the honest narrowing
      // (the locale layout already 404s anything outside routing.locales).
      const body = signOutSchema.parse({ locale })
      const res = await apiFetch(SIGN_OUT_ENDPOINT, {
        method: "POST",
        body: JSON.stringify(body),
      })
      // 401 means the session is already gone (another tab signed out, or it
      // expired). The user's goal — having no live session — is met, so this
      // is the same outcome as success, not an error to show.
      if (res.status === 401) {
        return {
          redirectTo: getPathname({ href: ROUTES.signIn, locale }),
          ssoLogout: SSO_LOGOUT.NOT_APPLICABLE,
        }
      }
      if (!res.ok) throw await readError(res, "Failed to sign out")
      return res.json() as Promise<SignOutResult>
    },
  })
}
