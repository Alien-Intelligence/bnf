"use client"

// hooks/api/users.ts
// TanStack Query hooks for the users model. Today: sign-out.
// All HTTP calls go through apiFetch — never raw fetch().

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useLocale } from "next-intl"
import { apiFetch, readError } from "@/lib/api-fetch"
import { AUTH_ENDPOINT } from "@/lib/constants"
import { signOutRequestSchema, type SignOutResult } from "@/models/users/types"
import { projectKeys } from "./projects"

// ── Keys and endpoints ──────────────────────────────────────────────────────

export const userKeys = {
  all: ["users"] as const,
  signOut: () => [...userKeys.all, "sign-out"] as const,
}

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
 * The signed-out user's queries are invalidated — on success and when the
 * session had already ended — without refetching (refetchType "none": a
 * refetch now would only collect 401s). The caller then leaves with a full
 * document navigation (ButtonAuthSignOut), which also discards the Next Client
 * Cache.
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
      const res = await apiFetch(AUTH_ENDPOINT.SIGN_OUT, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (res.status === 401) throw new SessionAlreadyEndedError()
      if (!res.ok) throw await readError(res, "Failed to sign out")
      return res.json() as Promise<SignOutResult>
    },
    onSuccess: () => invalidateSignedOutUser(qc),
    onError: (error) => {
      if (error instanceof SessionAlreadyEndedError) invalidateSignedOutUser(qc)
    },
  })
}

function invalidateSignedOutUser(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: userKeys.all, refetchType: "none" })
  void qc.invalidateQueries({ queryKey: projectKeys.all, refetchType: "none" })
}
