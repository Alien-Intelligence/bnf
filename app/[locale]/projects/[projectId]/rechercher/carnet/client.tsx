"use client"

import { useState } from "react"
import { LayoutCarnet } from "@/components/layouts/research/carnet"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import type { Note } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface CarnetClientProps {
  projectId: string
  initialNotes: Note[]
}

export function CarnetClient({ projectId, initialNotes }: CarnetClientProps) {
  const [selectedCitation, setSelectedCitation] =
    useState<ParsedCitation | null>(null)

  // The header is the project layout's; this fills its min-h-0 flex-1 slot.
  return (
    <>
      <div className="min-h-0 flex-1 overflow-hidden">
        <LayoutCarnet
          notes={initialNotes}
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
    </>
  )
}
