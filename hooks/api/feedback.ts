"use client"

// hooks/api/feedback.ts
// TanStack Query hooks for feedback (rating + optional comment) on a session,
// note, or turn. All HTTP goes through apiFetch — never raw fetch().
//
// Read surface is scoped to the CALLER's own feedback (GET returns only the
// authenticated user's rows) — it backs the per-target "already rated / edit"
// button state, not a team-wide viewer. One shared query per project means
// every feedback button on the page reads from a single cache entry.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { Feedback, FeedbackTarget } from "@/models/feedback/schema"
import type { SubmitFeedbackInput } from "@/models/feedback/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const feedbackKeys = {
  all: (projectId: string) => ["feedback", projectId] as const,
  mine: (projectId: string) => ["feedback", projectId, "mine"] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/** The current user's feedback rows for the project (all targets). */
export function useMyFeedback(projectId: string) {
  return useQuery<Feedback[]>({
    queryKey: feedbackKeys.mine(projectId),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/feedback`)
      if (!res.ok) throw new Error(`Failed to fetch feedback: ${res.status}`)
      return res.json() as Promise<Feedback[]>
    },
  })
}

/**
 * The user's existing feedback on one specific target, if any — drives the
 * button's rated/edit state and prefills the dialog. Reads from the shared
 * {@link useMyFeedback} cache, so it costs no extra request.
 */
export function useFeedbackForTarget(
  projectId: string,
  target: FeedbackTarget,
  targetId: string,
): Feedback | undefined {
  const { data } = useMyFeedback(projectId)
  return data?.find((f) => f.target === target && f.targetId === targetId)
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useSubmitFeedback(projectId: string) {
  const qc = useQueryClient()
  return useMutation<Feedback, Error, SubmitFeedbackInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/feedback`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to submit feedback: ${res.status}`)
      return res.json() as Promise<Feedback>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: feedbackKeys.mine(projectId) }),
  })
}
