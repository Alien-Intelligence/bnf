"use client"

// hooks/api/sessions.ts
// TanStack Query hooks for the sessions model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { AppSession } from "@/models/sessions/schema"
import type { CreateSessionInput, UpdateSessionInput } from "@/models/sessions/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const sessionKeys = {
  all: (projectId: string) => ["sessions", projectId] as const,
  list: (projectId: string, scope: string) =>
    ["sessions", projectId, "list", scope] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useSessions(
  projectId: string,
  scope: "corpus" | "research",
  opts: { initialData?: AppSession[] } = {},
) {
  return useQuery<AppSession[]>({
    queryKey: sessionKeys.list(projectId, scope),
    queryFn: async () => {
      const res = await apiFetch(
        `/api/projects/${projectId}/sessions?scope=${scope}`,
      )
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
      return res.json() as Promise<AppSession[]>
    },
    initialData: opts.initialData,
    staleTime: 30_000,
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useCreateSession(projectId: string) {
  const qc = useQueryClient()
  return useMutation<AppSession, Error, CreateSessionInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
      return res.json() as Promise<AppSession>
    },
    onSuccess: (_, variables) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.list(projectId, variables.scope),
      })
    },
  })
}

export function useRenameSession() {
  const qc = useQueryClient()
  return useMutation<
    AppSession,
    Error,
    { sessionId: string; projectId: string; scope: string } & UpdateSessionInput
  >({
    mutationFn: async ({ sessionId, title }) => {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`)
      return res.json() as Promise<AppSession>
    },
    onSuccess: (_, variables) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.list(variables.projectId, variables.scope),
      })
    },
  })
}

export function useArchiveSession(projectId: string) {
  const qc = useQueryClient()
  return useMutation<
    { archived: true },
    Error,
    { sessionId: string; scope: string }
  >({
    mutationFn: async ({ sessionId }) => {
      const res = await apiFetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(`Failed to archive session: ${res.status}`)
      return res.json() as Promise<{ archived: true }>
    },
    onSuccess: (_, variables) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.list(projectId, variables.scope),
      })
    },
  })
}
