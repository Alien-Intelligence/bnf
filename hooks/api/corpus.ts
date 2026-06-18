"use client"

// hooks/api/corpus.ts
// TanStack Query hooks for the corpus model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { CorpusDiff, CorpusSnapshot } from "@/models/corpus/schema"
import type { CorpusMutationResult } from "@/models/corpus/service"
import type { AddToCorpusInput, RemoveFromCorpusInput } from "@/models/corpus/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const corpusKeys = {
  all: (projectId: string) => ["corpus", projectId] as const,
  snapshot: (projectId: string, version: "head" | "ingested" | number) =>
    ["corpus", projectId, "snapshot", version] as const,
  diff: (projectId: string, from: number, to: number) =>
    ["corpus", projectId, "diff", from, to] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useCorpus(
  projectId: string,
  opts: { initialData?: CorpusSnapshot; version?: "head" | "ingested" | number } = {},
) {
  const version = opts.version ?? "head"
  return useQuery<CorpusSnapshot>({
    queryKey: corpusKeys.snapshot(projectId, version),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus?version=${version}`)
      if (!res.ok) throw new Error(`Failed to fetch corpus: ${res.status}`)
      return res.json() as Promise<CorpusSnapshot>
    },
    initialData: opts.initialData,
  })
}

export function useCorpusDiff(projectId: string, from: number, to: number) {
  return useQuery<CorpusDiff>({
    queryKey: corpusKeys.diff(projectId, from, to),
    queryFn: async () => {
      const res = await apiFetch(
        `/api/projects/${projectId}/corpus/diff?from=${from}&to=${to}`,
      )
      if (!res.ok) throw new Error("Failed to fetch corpus diff")
      return res.json() as Promise<CorpusDiff>
    },
    enabled: Number.isFinite(from) && Number.isFinite(to),
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useAddToCorpus(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CorpusMutationResult, Error, AddToCorpusInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus/add`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to add to corpus")
      return res.json() as Promise<CorpusMutationResult>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) }),
  })
}

export function useRemoveFromCorpus(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CorpusMutationResult, Error, RemoveFromCorpusInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus/remove`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to remove from corpus")
      return res.json() as Promise<CorpusMutationResult>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) }),
  })
}
