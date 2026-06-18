"use client"

import { NoteBody } from "./note-body"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface CarnetEntryProps {
  note: {
    id: string
    title: string
    body_md: string | null
    createdAt: Date | string
  }
  onCitationClick: (c: ParsedCitation) => void
}

export function CarnetEntry({ note, onCitationClick }: CarnetEntryProps) {
  const date = new Date(note.createdAt)
  const dateStr = date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })

  return (
    <article id={note.id} className="scroll-mt-4">
      <h2 className="text-xl font-semibold mb-1">{note.title}</h2>
      <p className="text-xs text-muted-foreground mb-4">{dateStr}</p>
      <NoteBody body={note.body_md ?? ""} onCitationClick={onCitationClick} />
    </article>
  )
}
