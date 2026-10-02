"use client"

// hooks/api/users.ts
// TanStack Query hooks for the users model. Today: sign-out.
// All HTTP calls go through apiFetch — never raw fetch().

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLocale } from "next-intl"
import { apiFetch, readError } from "@/lib/api-fetch"
import { signOutRequestSchema } from "@/lib/auth-redirect"
import type { SignOutResult } from "@/models/users/schema"

// ── Keys and endpoints ──────────────────────────────────────────────────────

export const userKeys = {
  all: ["users"] as const,
  signOut: () => [...userKeys.all, "sign-out"] as const,
}

const SIGN_OUT_ENDPOINT = "/api/sign-out"

/**
 * POST /api/sign-out answered 401: the session had already ended (another tab
 * signed out, or it expired) before this request. Not a failed sign-out, and
 * not a successful one either — no server decided anything about the
 * Authentik session. The caller decides what to show.
 */
export class SessionAlreadyEndedError extends Error {
  constructor() {
    super("The session had already ended")
    this.name = "SessionAlreadyEndedError"
  }
}

// ── Write hooks ─────────────────────────────────────────────────────────────

/**
 * POST /api/sign-out. The result is the server's: where the browser must go
 * next (the sign-in page, or Authentik's end-session URL) and what happened to
 * the Authentik session.
 *
 * Every cached query belongs to the user who just signed out, so the whole
 * cache is cleared — on success and when the session had already ended. The
 * caller still leaves with a full document navigation (ButtonAuthSignOut),
 * which also discards the Next Client Cache.
 */
export function useSignOut() {
  const locale = useLocale()
  const qc = useQueryClient()
  return useMutation<SignOutResult, Error, void>({
    mutationKey: userKeys.signOut(),
    mutationFn: async () => {
      // useLocale() is typed as a bare string; the schema is the honest
      // narrowing (the locale layout already 404s anything outside the list).
      const body = signOutRequestSchema.parse({ locale })
      const res = await apiFetch(SIGN_OUT_ENDPOINT, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (res.status === 401) throw new SessionAlreadyEndedError()
      if (!res.ok) throw await readError(res, "Failed to sign out")
      return res.json() as Promise<SignOutResult>
    },
    onSuccess: () => qc.clear(),
    onError: (error) => {
      if (error instanceof SessionAlreadyEndedError) qc.clear()
    },
  })
}
