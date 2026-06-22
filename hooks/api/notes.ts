"use client"

// hooks/api/notes.ts
// TanStack Query hooks for the notes model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { NoteListItem, NoteWithCitations, NoteVersionListItem } from "@/models/notes/schema"
import type { CreateNoteInput, UpdateNoteInput } from "@/models/notes/types"

// ── Query keys ────────────────────────────────────────────────────────────────

export const noteKeys = {
  all: (projectId: string) => ["notes", projectId] as const,
  list: (projectId: string) => ["notes", projectId, "list"] as const,
  detail: (noteId: string) => ["notes", "detail", noteId] as const,
  versions: (noteId: string) => ["notes", "versions", noteId] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useNotes(
  projectId: string,
  opts: { initialData?: NoteListItem[] } = {},
) {
  return useQuery<NoteListItem[]>({
    queryKey: noteKeys.list(projectId),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/notes`)
      if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`)
      return res.json() as Promise<NoteListItem[]>
    },
    initialData: opts.initialData,
  })
}

export function useNoteVersions(noteId: string | null) {
  return useQuery<{ versions: NoteVersionListItem[] }>({
    queryKey: noteId ? noteKeys.versions(noteId) : ["notes", "versions", null],
    queryFn: async () => {
      const res = await apiFetch(`/api/notes/${noteId!}/versions`)
      if (!res.ok) throw new Error(`Failed to fetch note versions: ${res.status}`)
      return res.json() as Promise<{ versions: NoteVersionListItem[] }>
    },
    enabled: !!noteId,
  })
}

export function useNote(noteId: string | null) {
  return useQuery<NoteWithCitations>({
    queryKey: noteId ? noteKeys.detail(noteId) : ["notes", "detail", null],
    queryFn: async () => {
      const res = await apiFetch(`/api/notes/${noteId!}`)
      if (!res.ok) throw new Error(`Failed to fetch note: ${res.status}`)
      return res.json() as Promise<NoteWithCitations>
    },
    enabled: !!noteId,
  })
}

/**
 * Fetch the full body (+ citations) of several notes at once — the in-page
 * Carnet stitches every note into one document. Shares the per-note detail
 * cache with {@link useNote}, so notes already opened in the Atelier resolve
 * instantly. Order follows `noteIds`.
 */
export function useNoteDetails(noteIds: string[]) {
  return useQueries({
    queries: noteIds.map((id) => ({
      queryKey: noteKeys.detail(id),
      queryFn: async () => {
        const res = await apiFetch(`/api/notes/${id}`)
        if (!res.ok) throw new Error(`Failed to fetch note: ${res.status}`)
        return res.json() as Promise<NoteWithCitations>
      },
    })),
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useCreateNote(projectId: string) {
  const qc = useQueryClient()
  return useMutation<NoteWithCitations, Error, CreateNoteInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/notes`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to create note: ${res.status}`)
      return res.json() as Promise<NoteWithCitations>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list(projectId) }),
  })
}

export function useUpdateNote(noteId: string) {
  const qc = useQueryClient()
  return useMutation<NoteWithCitations, Error, UpdateNoteInput & { projectId: string }>({
    mutationFn: async ({ projectId: _projectId, ...body }) => {
      const res = await apiFetch(`/api/notes/${noteId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to update note: ${res.status}`)
      return res.json() as Promise<NoteWithCitations>
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
      qc.invalidateQueries({ queryKey: noteKeys.detail(noteId) })
    },
  })
}

export function useDeleteNote(projectId: string) {
  const qc = useQueryClient()
  return useMutation<{ deleted: true }, Error, { noteId: string }>({
    mutationFn: async ({ noteId }) => {
      const res = await apiFetch(`/api/notes/${noteId}`, { method: "DELETE" })
      if (!res.ok) throw new Error(`Failed to delete note: ${res.status}`)
      return res.json() as Promise<{ deleted: true }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list(projectId) }),
  })
}
