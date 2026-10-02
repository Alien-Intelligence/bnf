"use client"

import { useState } from "react"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutCarnet } from "@/components/layouts/research/carnet"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import { useNoteDetails } from "@/hooks/api/notes"
import type { NoteDetail } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"
import type { WorkspaceStep } from "@/lib/constants"

interface CarnetClientProps {
  projectId: string
  initialUser: { name?: string | null; email: string }
  /** The steps this user has on this project — see LayoutWorkspaceStepNav. */
  initialWorkspaceSteps: readonly WorkspaceStep[]
  initialNotes: NoteDetail[]
}

export function CarnetClient({
  projectId,
  initialUser,
  initialWorkspaceSteps,
  initialNotes,
}: CarnetClientProps) {
  const [selectedCitation, setSelectedCitation] =
    useState<ParsedCitation | null>(null)

  // Found bug B8: the notes used to render from frozen server props. They now
  // go through the per-note query cache, seeded with the server-loaded details,
  // so they refetch and stay in sync with the Atelier like every other view.
  const results = useNoteDetails(
    initialNotes.map((n) => n.id),
    { initialData: initialNotes },
  )
  const details = results.map((r) => r.data)
  const failed = results.filter((r) => r.isError)
  const notes = details.every((d): d is NoteDetail => d !== undefined) ? details : undefined

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
          notes={notes}
          isError={failed.length > 0}
          onRetry={() => {
            for (const r of failed) void r.refetch()
          }}
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
