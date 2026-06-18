"use client"

// hooks/api/citations.ts
// TanStack Query hook for citation lookups by ARK within a project.

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"

// Shape returned by NoteQueries.citationsForArk — kept inline here since it
// is a projection (not a full schema type) and is small enough to avoid a
// separate import chain.
export type CitationUsage = {
  noteId: string
  folio: number | null
  label: string | null
  noteTitle: string
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const citationKeys = {
  forArk: (projectId: string, ark: string) =>
    ["citations", projectId, ark] as const,
}

// ── Read hook ─────────────────────────────────────────────────────────────────

/**
 * Fetch all citation usages for a given ARK within a project.
 * The query is disabled when `ark` is null — safe to call unconditionally.
 */
export function useCitationsForArk(projectId: string, ark: string | null) {
  return useQuery<CitationUsage[]>({
    queryKey: ark ? citationKeys.forArk(projectId, ark) : ["citations", projectId, null],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/projects/${projectId}/citations?ark=${encodeURIComponent(ark!)}`,
      )
      if (!res.ok) throw new Error("Failed to fetch citation usages")
      return res.json() as Promise<CitationUsage[]>
    },
    enabled: !!ark,
  })
}
