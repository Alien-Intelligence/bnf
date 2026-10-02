"use client"

import { useFormatter } from "next-intl"
import { NoteBody } from "./note-body"
import type { ParsedCitation } from "@/lib/citations/syntax"
import type { NoteDetail } from "@/models/notes/schema"

interface CarnetEntryProps {
  note: NoteDetail
  onCitationClick: (c: ParsedCitation) => void
  onNoteLinkClick?: (noteId: string) => void
  knownNoteIds?: ReadonlySet<string>
}

export function CarnetEntry({
  note,
  onCitationClick,
  onNoteLinkClick,
  knownNoteIds,
}: CarnetEntryProps) {
  // The date follows the active locale (an EN carnet must not print French
  // month names next to an English banner).
  const format = useFormatter()
  const dateStr = format.dateTime(new Date(note.createdAt), {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })

  return (
    <article>
      <h2 className="text-xl font-semibold mb-1">{note.title}</h2>
      <p className="text-xs text-muted-foreground mb-4">{dateStr}</p>
      <NoteBody
        body={note.body_md ?? ""}
        folioOcr={note.folioOcr}
        documentOcr={note.documentOcr}
        onCitationClick={onCitationClick}
        onNoteLinkClick={onNoteLinkClick}
        knownNoteIds={knownNoteIds}
      />
    </article>
  )
}
