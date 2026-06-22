"use client"

// components/cards/notes/list-item.tsx
// CardNoteListItem — one row in the research artefacts picker (prototype rail,
// lines 156-164): file icon + note title + a mono meta line (citation count ·
// relative update time). Active when the note is the one open in the reader.

import { FileText } from "lucide-react"
import { useTranslations } from "next-intl"
import { formatRelativeFr } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { NoteListItem } from "@/models/notes/schema"

interface CardNoteListItemProps {
  note: NoteListItem
  isActive: boolean
  onClick: () => void
}

export function CardNoteListItem({ note, isActive, onClick }: CardNoteListItemProps) {
  const t = useTranslations("research.artefacts")

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-foreground hover:bg-muted",
      )}
    >
      <FileText
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          isActive ? "text-primary" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{note.title}</span>
        <span className="block truncate font-mono text-[9.5px] text-muted-foreground">
          {t("meta", {
            count: note.citationCount,
            time: formatRelativeFr(note.updatedAt),
          })}
        </span>
      </span>
    </button>
  )
}
