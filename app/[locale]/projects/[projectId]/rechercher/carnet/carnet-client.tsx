"use client"

import { useState } from "react"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutCarnet } from "@/components/layouts/research/carnet"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import type { Note } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface CarnetClientProps {
  projectId: string
  initialUser: { name?: string | null; email: string }
  notes: Note[]
}

export function CarnetClient({
  projectId,
  initialUser,
  notes,
}: CarnetClientProps) {
  const [selectedCitation, setSelectedCitation] =
    useState<ParsedCitation | null>(null)

  const user: { name?: string; email: string } = {
    name: initialUser.name ?? undefined,
    email: initialUser.email,
  }

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader user={user} projectId={projectId} />
      <div className="flex-1 overflow-hidden">
        <LayoutCarnet
          notes={notes}
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
