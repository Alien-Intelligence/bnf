"use client"

// hooks/api/memory.ts
// TanStack Query hooks for the memory model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { MemorySnapshot } from "@/models/memory/schema"

// ── Query keys ────────────────────────────────────────────────────────────────

export const memoryKeys = {
  all: (projectId: string, scope: string) => ["memory", projectId, scope] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useMemory(projectId: string, scope: "corpus" | "research") {
  return useQuery<MemorySnapshot>({
    queryKey: memoryKeys.all(projectId, scope),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/memory?scope=${scope}`)
      if (!res.ok) throw new Error(`Failed to fetch memory: ${res.status}`)
      return res.json() as Promise<MemorySnapshot>
    },
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useForgetMemoryItem(projectId: string, scope: "corpus" | "research") {
  const qc = useQueryClient()
  return useMutation<{ deleted: true }, Error, { itemId: string }>({
    mutationFn: async ({ itemId }) => {
      const res = await apiFetch(
        `/api/projects/${projectId}/memory/${itemId}?scope=${scope}`,
        { method: "DELETE" },
      )
      if (!res.ok) throw new Error(`Failed to delete memory item: ${res.status}`)
      return res.json() as Promise<{ deleted: true }>
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: memoryKeys.all(projectId, scope) }),
  })
}
