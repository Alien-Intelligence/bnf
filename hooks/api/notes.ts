"use client"

// hooks/api/notes.ts
// TanStack Query hooks for the notes model.
// All HTTP calls go through apiFetch — never raw fetch().
// Endpoints and query keys are defined once at the top; never inlined at the
// call site (a disabled query's key comes from the same factory, with null).

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type {
  NoteDeleted,
  NoteDetail,
  NoteListItem,
  NoteVersionList,
} from "@/models/notes/schema"
import type { CreateNoteInput, UpdateNoteInput } from "@/models/notes/types"

// ── Endpoints ─────────────────────────────────────────────────────────────────

const PROJECT_NOTES_ENDPOINT = (projectId: string) => `/api/projects/${projectId}/notes`
const NOTE_ENDPOINT = (noteId: string) => `/api/notes/${noteId}`
const NOTE_VERSIONS_ENDPOINT = (noteId: string) => `/api/notes/${noteId}/versions`

// ── Query keys ────────────────────────────────────────────────────────────────

export const noteKeys = {
  all: (projectId: string) => ["notes", projectId] as const,
  list: (projectId: string) => ["notes", projectId, "list"] as const,
  /** null = no note selected (the query is disabled). */
  detail: (noteId: string | null) => ["notes", "detail", noteId] as const,
  /** null = no note selected (the query is disabled). */
  versions: (noteId: string | null) => ["notes", "versions", noteId] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

export function useNotes(
  projectId: string,
  opts: { initialData?: NoteListItem[] } = {},
) {
  return useQuery<NoteListItem[]>({
    queryKey: noteKeys.list(projectId),
    queryFn: async () => {
      const res = await apiFetch(PROJECT_NOTES_ENDPOINT(projectId))
      if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`)
      return res.json() as Promise<NoteListItem[]>
    },
    initialData: opts.initialData,
  })
}

export function useNoteVersions(noteId: string | null) {
  return useQuery<NoteVersionList>({
    queryKey: noteKeys.versions(noteId),
    queryFn: async () => {
      if (noteId === null) throw new Error("useNoteVersions: queryFn ran without a note id")
      const res = await apiFetch(NOTE_VERSIONS_ENDPOINT(noteId))
      if (!res.ok) throw new Error(`Failed to fetch note versions: ${res.status}`)
      return res.json() as Promise<NoteVersionList>
    },
    enabled: noteId !== null,
  })
}

/** GET /api/notes/:nid — the note with its citations and their folios' OCR quality. */
async function fetchNoteDetail(noteId: string): Promise<NoteDetail> {
  const res = await apiFetch(NOTE_ENDPOINT(noteId))
  if (!res.ok) throw new Error(`Failed to fetch note: ${res.status}`)
  return res.json() as Promise<NoteDetail>
}

export function useNote(noteId: string | null) {
  return useQuery<NoteDetail>({
    queryKey: noteKeys.detail(noteId),
    queryFn: () => {
      if (noteId === null) throw new Error("useNote: queryFn ran without a note id")
      return fetchNoteDetail(noteId)
    },
    enabled: noteId !== null,
  })
}

/**
 * Fetch the full body (+ citations and their folios' OCR quality) of several
 * notes at once — the Carnet stitches every note into one document. Shares the
 * per-note detail cache with {@link useNote}, so notes already opened in the
 * Atelier resolve instantly. Order follows `noteIds`.
 */
export function useNoteDetails(noteIds: string[]) {
  return useQueries({
    queries: noteIds.map((id) => ({
      queryKey: noteKeys.detail(id),
      queryFn: () => fetchNoteDetail(id),
    })),
  })
}

// ── Write hooks ───────────────────────────────────────────────────────────────

export function useCreateNote(projectId: string) {
  const qc = useQueryClient()
  return useMutation<NoteDetail, Error, CreateNoteInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(PROJECT_NOTES_ENDPOINT(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to create note: ${res.status}`)
      return res.json() as Promise<NoteDetail>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list(projectId) }),
  })
}

export function useUpdateNote(noteId: string) {
  const qc = useQueryClient()
  return useMutation<NoteDetail, Error, UpdateNoteInput & { projectId: string }>({
    mutationFn: async ({ projectId: _projectId, ...body }) => {
      const res = await apiFetch(NOTE_ENDPOINT(noteId), {
        method: "PUT",
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to update note: ${res.status}`)
      return res.json() as Promise<NoteDetail>
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
      qc.invalidateQueries({ queryKey: noteKeys.detail(noteId) })
    },
  })
}

export function useDeleteNote(projectId: string) {
  const qc = useQueryClient()
  return useMutation<NoteDeleted, Error, { noteId: string }>({
    mutationFn: async ({ noteId }) => {
      const res = await apiFetch(NOTE_ENDPOINT(noteId), { method: "DELETE" })
      if (!res.ok) throw new Error(`Failed to delete note: ${res.status}`)
      return res.json() as Promise<NoteDeleted>
    },
    onSuccess: (_data, { noteId }) => {
      // The deleted note's detail entry must not linger: the Carnet would keep
      // rendering (or refetching into a 404) a note that no longer exists.
      qc.removeQueries({ queryKey: noteKeys.detail(noteId) })
      qc.removeQueries({ queryKey: noteKeys.versions(noteId) })
      return qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
    },
  })
}
