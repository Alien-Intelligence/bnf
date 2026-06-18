"use client"

// hooks/api/corpus.ts
// TanStack Query hooks for the corpus model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { CorpusDiff, CorpusSnapshot } from "@/models/corpus/schema"
import type { CorpusMutationResult } from "@/models/corpus/service"
import {
  corpusFiltersToParams,
  type AddToCorpusInput,
  type CorpusFilters,
  type RemoveFromCorpusInput,
} from "@/models/corpus/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const corpusKeys = {
  all: (projectId: string) => ["corpus", projectId] as const,
  snapshot: (projectId: string, filters: CorpusFilters) =>
    ["corpus", projectId, "snapshot", filters] as const,
  diff: (projectId: string, from: number, to: number) =>
    ["corpus", projectId, "diff", from, to] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/**
 * Paginated infinite query for the corpus comprehension panel.
 * Each page corresponds to one API response (bounded sample + nextCursor).
 * Filters are part of the query key — changing filters resets pagination to
 * the first page automatically.
 */
export function useCorpus(
  projectId: string,
  filters: CorpusFilters,
  opts: { initialSnapshot?: CorpusSnapshot } = {},
) {
  return useInfiniteQuery({
    queryKey: corpusKeys.snapshot(projectId, filters),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params = corpusFiltersToParams(filters)
      if (pageParam) params.set("cursor", pageParam)
      const res = await apiFetch(
        `/api/projects/${projectId}/corpus?${params.toString()}`,
      )
      if (!res.ok) throw new Error(`Failed to fetch corpus: ${res.status}`)
      return res.json() as Promise<CorpusSnapshot>
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CorpusSnapshot) => last.nextCursor,
    initialData: opts.initialSnapshot
      ? { pages: [opts.initialSnapshot], pageParams: [undefined] }
      : undefined,
    staleTime: 30_000,
  })
}

/**
 * Convenience wrapper over useCorpus that flattens all loaded pages into a
 * single CorpusSnapshot-shaped object. The first page's metadata (facets,
 * total, undatedCount, versionSeq, versionStatus) is canonical; sample rows
 * are concatenated across all loaded pages.
 */
export function useCorpusFlattened(
  projectId: string,
  filters: CorpusFilters,
  opts: { initialSnapshot?: CorpusSnapshot } = {},
) {
  const query = useCorpus(projectId, filters, opts)
  const pages = query.data?.pages ?? []
  const first = pages[0]
  const sample = pages.flatMap((p) => p.sample)

  return {
    ...query,
    snapshot: first
      ? { ...first, sample, undatedCount: first.undatedCount }
      : undefined,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  }
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
