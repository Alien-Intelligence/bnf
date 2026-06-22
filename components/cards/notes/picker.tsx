"use client"

// components/cards/notes/picker.tsx
// CardNotesPicker — the "Artefacts de recherche" section of the research rail
// (prototype lines 142-168): an eyebrow + new-note button, a search box, the
// scrollable list of artefacts, and a count footer. Lives between the session
// list and the memory box via LayoutSessionsSidebar's `artefactsSlot`.
//
// It reads the same useNotes query the espace seeds, so the list stays live
// (agent-authored notes appear after a turn) without a second source of truth.

import { useMemo, useState } from "react"
import { Plus, Search } from "lucide-react"
import { useTranslations } from "next-intl"
import { useNotes } from "@/hooks/api/notes"
import { CardNoteListItem } from "./list-item"
import type { NoteListItem } from "@/models/notes/schema"

interface CardNotesPickerProps {
  projectId: string
  activeNoteId: string | null
  onOpenNote: (id: string) => void
  onNewNote: () => void
  initialNotes?: NoteListItem[]
}

export function CardNotesPicker({
  projectId,
  activeNoteId,
  onOpenNote,
  onNewNote,
  initialNotes,
}: CardNotesPickerProps) {
  const t = useTranslations("research.artefacts")
  const [query, setQuery] = useState("")

  const { data: notes } = useNotes(projectId, { initialData: initialNotes })

  const filtered = useMemo(() => {
    const all = notes ?? []
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((n) => n.title.toLowerCase().includes(q))
  }, [notes, query])

  const total = notes?.length ?? 0

  return (
    <div className="flex min-h-[148px] flex-1 flex-col border-t">
      {/* Header — eyebrow + new note */}
      <div className="shrink-0 px-3.5 pb-2 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="mono-eyebrow">{t("title")}</span>
          <button
            type="button"
            onClick={onNewNote}
            title={t("new")}
            aria-label={t("new")}
            className="flex size-5.5 items-center justify-center rounded-md border bg-card text-neutral-300 transition-colors hover:border-brand-teal/45 hover:text-brand-teal"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="flex h-7.5 items-center gap-2 rounded-md border border-input bg-input/30 px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search")}
            className="w-full bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2.5">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {total === 0 ? t("empty") : t("noMatch")}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((note) => (
              <CardNoteListItem
                key={note.id}
                note={note}
                isActive={note.id === activeNoteId}
                onClick={() => onOpenNote(note.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Count footer */}
      <div className="shrink-0 border-t px-3.5 py-1.5 font-mono text-[10px] text-neutral-600">
        {t("count", { count: total })}
      </div>
    </div>
  )
}
