"use client"

import { useMemo, useState } from "react"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import {
  LayoutCarnet,
  type CarnetEntryState,
  type CarnetListState,
} from "@/components/layouts/research/carnet"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import { useNoteDetails, useNotes } from "@/hooks/api/notes"
import type { NoteListItem } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"
import type { WorkspaceStep } from "@/lib/constants"

interface CarnetClientProps {
  projectId: string
  initialUser: { name?: string | null; email: string }
  /** The steps this user has on this project — see LayoutWorkspaceStepNav. */
  initialWorkspaceSteps: readonly WorkspaceStep[]
  /** The project's notes (the carnet's note set), seeding useNotes. */
  initialNoteList: NoteListItem[]
}

export function CarnetClient({
  projectId,
  initialUser,
  initialWorkspaceSteps,
  initialNoteList,
}: CarnetClientProps) {
  const [selectedCitation, setSelectedCitation] =
    useState<ParsedCitation | null>(null)

  // Found bug B8: the carnet used to render frozen server props. The note SET
  // comes from the notes list query (seeded with the server-loaded list) and
  // each body from the per-note detail query, so a note added or deleted later
  // (in the Atelier, by the agent) shows up here too. The carnet reads front
  // to back, so the list is ordered by creation date.
  const list = useNotes(projectId, { initialData: initialNoteList })
  const ordered = useMemo(
    () =>
      [...(list.data ?? [])].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [list.data],
  )
  const results = useNoteDetails(ordered.map((n) => n.id))
  const entries = ordered.map((n, i) => {
    const r = results[i]
    // A background refetch that fails while data is in hand keeps showing it:
    // only a note with nothing to show is an error.
    let state: CarnetEntryState
    if (r.data !== undefined) state = { kind: "ready", note: r.data }
    else if (r.isError) state = { kind: "error", retry: () => void r.refetch() }
    else state = { kind: "loading" }
    return { id: n.id, title: n.title, state }
  })
  let listState: CarnetListState
  if (list.data !== undefined) listState = { kind: "ready", entries }
  else if (list.isError) listState = { kind: "error", retry: () => void list.refetch() }
  else listState = { kind: "loading" }

  const user: { name?: string; email: string } = {
    name: initialUser.name ?? undefined,
    email: initialUser.email,
  }

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader
        user={user}
        projectId={projectId}
        workspaceSteps={initialWorkspaceSteps}
      />
      <div className="flex-1 overflow-hidden">
        <LayoutCarnet
          list={listState}
          onCitationClick={setSelectedCitation}
        />
      </div>

      <SheetCitationSource
        projectId={projectId}
        ark={selectedCitation?.ark ?? null}
        folio={selectedCitation?.folio ?? null}
        label={selectedCitation?.label ?? null}
        open={!!selectedCitation}
        onOpenChange={(o) => {
          if (!o) setSelectedCitation(null)
        }}
      />
    </div>
  )
}
