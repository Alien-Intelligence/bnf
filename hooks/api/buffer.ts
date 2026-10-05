"use client"

// hooks/api/buffer.ts
// TanStack Query hooks for the research buffer ("tampon").
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import { apiFetch, readQueryError, retryUnlessRefused } from "@/lib/api-fetch"
import { corpusKeys } from "./corpus"
import { bufferFilterQuery } from "@/lib/buffer/filter-query"
import type { BufferCommitCounts, BufferSnapshot } from "@/models/buffer/schema"
import type { CorpusAddResult } from "@/models/corpus/schema"

/** What POST /buffer/commit returns: the buffer counters and the corpus add result. */
type BufferCommitResponse = BufferCommitCounts & { corpus: CorpusAddResult }
import type { BufferCommitInput, BufferDiscardInput, BufferFilterSet } from "@/models/buffer/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const bufferKeys = {
  all: (projectId: string) => ["buffer", projectId] as const,
  snapshot: (projectId: string, filters: BufferFilterSet) =>
    ["buffer", projectId, "snapshot", filters] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/** The buffer comprehension snapshot (total + facets + candidate sample). */
export function useBuffer(
  projectId: string,
  filters: BufferFilterSet,
  opts: { limit?: number; initialSnapshot?: BufferSnapshot } = {},
) {
  return useQuery<BufferSnapshot>({
    queryKey: bufferKeys.snapshot(projectId, filters),
    queryFn: async () => {
      const params = bufferFilterQuery.encode(filters)
      if (opts.limit !== undefined) params.set("limit", String(opts.limit))
      const qs = params.toString()
      const res = await apiFetch(`/api/projects/${projectId}/buffer${qs ? `?${qs}` : ""}`)
      // A 400 (a filter the buffer refuses) carries its message to the dialog.
      if (!res.ok) throw await readQueryError(res, "Failed to fetch buffer")
      return res.json() as Promise<BufferSnapshot>
    },
    retry: retryUnlessRefused,
    initialData: opts.initialSnapshot,
    // Keep the previous result visible across a filter change instead of a
    // skeleton flash; isPlaceholderData flags the transition.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

/** Commit the buffer's candidates into the corpus ("Ajouter au corpus"). */
export function useCommitBuffer(projectId: string) {
  const qc = useQueryClient()
  return useMutation<BufferCommitResponse, Error, BufferCommitInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/buffer/commit`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to commit buffer")
      return res.json() as Promise<BufferCommitResponse>
    },
    // A commit empties the buffer AND grows the corpus — refresh both.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bufferKeys.all(projectId) })
      void qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) })
    },
  })
}

/** Empty the buffer ("Vider le tampon"). */
export function useClearBuffer(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ cleared: number }, Error, void>({
    mutationFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/buffer/clear`, { method: "POST" })
      if (!res.ok) throw new Error("Failed to clear buffer")
      return res.json() as Promise<{ cleared: number }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: bufferKeys.all(projectId) }),
  })
}

/** Discard specific candidates by ARK (per-candidate removal in the panel). */
export function useDiscardCandidates(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ discarded: number }, Error, BufferDiscardInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/buffer`, {
        method: "DELETE",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to discard candidates")
      return res.json() as Promise<{ discarded: number }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: bufferKeys.all(projectId) }),
  })
}
