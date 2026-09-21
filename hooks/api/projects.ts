"use client"

// hooks/api/projects.ts
// TanStack Query hooks for the projects model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch, readError } from "@/lib/api-fetch"
import { groupKeys } from "./groups"
import type { Project, ProjectListItem } from "@/models/projects/schema"
import type { ShareWithGroup } from "@/models/projects/schema"
import type {
  CreateDerivedProjectInput,
  CreateProjectRequest,
  ShareProjectInput,
} from "@/models/projects/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const projectKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  shares: (projectId: string) => ["projects", projectId, "shares"] as const,
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
      // Granting adds a row to the target group's shares, and the admin Groups
      // table renders that count from the groups list.
      qc.invalidateQueries({ queryKey: groupKeys.list })
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
      // Revoking removes a row from the target group's shares, so the count in
      // the admin Groups table is stale until the groups list is re-fetched.
      qc.invalidateQueries({ queryKey: groupKeys.list })
    },
  })
}

// ── Derived projects ──────────────────────────────────────────────────────────

export function useCreateDerivedProject() {
  const qc = useQueryClient()
  return useMutation<Project, Error, CreateDerivedProjectInput>({
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
