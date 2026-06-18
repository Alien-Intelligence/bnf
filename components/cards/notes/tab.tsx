"use client"

import { useNote } from "@/hooks/api/notes"
import { NoteBody } from "./note-body"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface NoteTabProps {
  noteId: string
  onCitationClick: (c: ParsedCitation) => void
}

export function NoteTab({ noteId, onCitationClick }: NoteTabProps) {
  const { data: note, isLoading, isError, refetch } = useNote(noteId)

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  if (isError || !note) {
    return (
      <div className="p-4 flex flex-col items-center gap-3 text-muted-foreground">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm">Impossible de charger la note.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Réessayer
        </Button>
      </div>
    )
  }

  return (
    <div className="p-4 overflow-y-auto">
      <h2 className="text-lg font-semibold mb-4">{note.title}</h2>
      <NoteBody body={note.body_md ?? ""} onCitationClick={onCitationClick} />
    </div>
  )
}
