"use client"

// hooks/api/projects.ts
// TanStack Query hooks for the projects model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { Project, ProjectListItem } from "@/models/projects/schema"
import type { ShareWithGroup } from "@/models/projects/sharing"
import type {
  CreateDerivedProjectRequest,
  CreateProjectRequest,
  ShareProjectInput,
} from "@/models/projects/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const projectKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  shares: (projectId: string) => ["projects", projectId, "shares"] as const,
}

/**
 * Surfaces the server's message when there is one. The sharing API answers 422
 * with a French sentence the owner can act on; collapsing it into a generic
 * "erreur" would hide the one thing they need to know.
 */
async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === "string" && body.error.length > 0) {
      return new Error(body.error)
    }
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through to the fallback.
  }
  return new Error(`${fallback}: ${res.status}`)
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useProjects(opts: { initialData?: ProjectListItem[] } = {}) {
  return useQuery<ProjectListItem[]>({
    queryKey: projectKeys.list,
    queryFn: async () => {
      const res = await apiFetch("/api/projects")
      if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`)
      return res.json() as Promise<ProjectListItem[]>
    },
    initialData: opts.initialData,
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation<Project, Error, CreateProjectRequest>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to create project: ${res.status}`)
      return res.json() as Promise<Project>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.list }),
  })
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export function useProjectShares(projectId: string, enabled = true) {
  return useQuery<ShareWithGroup[]>({
    queryKey: projectKeys.shares(projectId),
    enabled,
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/shares`)
      if (!res.ok) throw await readError(res, "Failed to fetch shares")
      return res.json() as Promise<ShareWithGroup[]>
    },
  })
}

export function useShareProject(projectId: string) {
  const qc = useQueryClient()
  return useMutation<ShareWithGroup[], Error, ShareProjectInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/shares`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await readError(res, "Failed to share project")
      return res.json() as Promise<ShareWithGroup[]>
    },
    onSuccess: (data) => {
      qc.setQueryData(projectKeys.shares(projectId), data)
      qc.invalidateQueries({ queryKey: projectKeys.list })
    },
  })
}

export function useUnshareProject(projectId: string) {
  const qc = useQueryClient()
  return useMutation<ShareWithGroup[], Error, string>({
    mutationFn: async (groupId) => {
      const res = await apiFetch(
        `/api/projects/${projectId}/shares/${groupId}`,
        { method: "DELETE" },
      )
      if (!res.ok) throw await readError(res, "Failed to revoke share")
      return res.json() as Promise<ShareWithGroup[]>
    },
    onSuccess: (data) => {
      qc.setQueryData(projectKeys.shares(projectId), data)
      qc.invalidateQueries({ queryKey: projectKeys.list })
    },
  })
}

// ── Derived projects ──────────────────────────────────────────────────────────

export function useCreateDerivedProject() {
  const qc = useQueryClient()
  return useMutation<Project, Error, CreateDerivedProjectRequest>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/projects/derived", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await readError(res, "Failed to create workspace")
      return res.json() as Promise<Project>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.list }),
  })
}
