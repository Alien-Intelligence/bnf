"use client"

// hooks/api/projects.ts
// TanStack Query hooks for the projects model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { Project, ProjectListItem } from "@/models/projects/schema"
import type { CreateProjectRequest } from "@/models/projects/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const projectKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
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
