"use client"

// hooks/api/groups.ts
// TanStack Query hooks for the groups model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { Group, GroupListItem, GroupWithMembers } from "@/models/groups/schema"
import type {
  AddMemberInput,
  CreateGroupInput,
  RenameGroupInput,
} from "@/models/groups/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const groupKeys = {
  all: ["groups"] as const,
  list: ["groups", "list"] as const,
  members: (gid: string) => ["groups", gid, "members"] as const,
}

/**
 * Surfaces the server's message when there is one. The groups API answers 409
 * (name taken) and 422 (unknown email, unusable name) with a French sentence
 * the admin can act on; swallowing it into a generic "erreur" would hide the
 * one thing they need to know.
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

export function useGroups(opts: { initialData?: GroupListItem[] } = {}) {
  return useQuery<GroupListItem[]>({
    queryKey: groupKeys.list,
    queryFn: async () => {
      const res = await apiFetch("/api/groups")
      if (!res.ok) throw await readError(res, "Failed to fetch groups")
      return res.json() as Promise<GroupListItem[]>
    },
    initialData: opts.initialData,
  })
}

export function useGroupMembers(gid: string | null) {
  return useQuery<GroupWithMembers>({
    queryKey: groupKeys.members(gid ?? "none"),
    enabled: gid !== null,
    queryFn: async () => {
      const res = await apiFetch(`/api/groups/${gid}/members`)
      if (!res.ok) throw await readError(res, "Failed to fetch members")
      return res.json() as Promise<GroupWithMembers>
    },
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useCreateGroup() {
  const qc = useQueryClient()
  return useMutation<Group, Error, CreateGroupInput>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/groups", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await readError(res, "Failed to create group")
      return res.json() as Promise<Group>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groupKeys.list }),
  })
}

export function useRenameGroup(gid: string) {
  const qc = useQueryClient()
  return useMutation<Group, Error, RenameGroupInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/groups/${gid}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await readError(res, "Failed to rename group")
      return res.json() as Promise<Group>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groupKeys.list }),
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  return useMutation<{ deleted: true }, Error, string>({
    mutationFn: async (gid) => {
      const res = await apiFetch(`/api/groups/${gid}`, { method: "DELETE" })
      if (!res.ok) throw await readError(res, "Failed to delete group")
      return res.json() as Promise<{ deleted: true }>
    },
    // A deleted group cascades to its shares, so the projects list changes too.
    onSuccess: () => qc.invalidateQueries({ queryKey: groupKeys.all }),
  })
}

export function useAddMember(gid: string) {
  const qc = useQueryClient()
  return useMutation<GroupWithMembers, Error, AddMemberInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/groups/${gid}/members`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await readError(res, "Failed to add member")
      return res.json() as Promise<GroupWithMembers>
    },
    onSuccess: (data) => {
      qc.setQueryData(groupKeys.members(gid), data)
      qc.invalidateQueries({ queryKey: groupKeys.list })
    },
  })
}

export function useRemoveMember(gid: string) {
  const qc = useQueryClient()
  return useMutation<GroupWithMembers, Error, string>({
    mutationFn: async (uid) => {
      const res = await apiFetch(`/api/groups/${gid}/members/${uid}`, {
        method: "DELETE",
      })
      if (!res.ok) throw await readError(res, "Failed to remove member")
      return res.json() as Promise<GroupWithMembers>
    },
    onSuccess: (data) => {
      qc.setQueryData(groupKeys.members(gid), data)
      qc.invalidateQueries({ queryKey: groupKeys.list })
    },
  })
}
