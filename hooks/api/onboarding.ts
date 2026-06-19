"use client"

// hooks/api/onboarding.ts
// Mutation hook for recording that a user has dismissed a guided intro.
// Seen state is read once (server-side, passed as initial props), so there is
// no query to invalidate — this is a fire-and-forget write.

import { useMutation } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { MarkOnboardingSeenInput } from "@/models/onboarding/types"

export function useMarkOnboardingSeen() {
  return useMutation<{ ok: true }, Error, MarkOnboardingSeenInput>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to mark onboarding seen: ${res.status}`)
      return res.json() as Promise<{ ok: true }>
    },
  })
}
