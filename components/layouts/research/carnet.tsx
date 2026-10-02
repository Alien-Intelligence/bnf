"use client"

import { useMemo } from "react"
import { CarnetEntry } from "@/components/cards/notes/carnet-entry"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { notesToMarkdown, downloadMarkdown } from "@/lib/notes/export"
import { useNoteExportCopy } from "@/lib/notes/export-copy"
import type { NoteDetail } from "@/models/notes/schema"

interface LayoutCarnetProps {
  /** Every note of the carnet, oldest first; undefined until all of them are loaded. */
  notes: NoteDetail[] | undefined
  /** At least one note failed to load — the carnet says so and offers a retry. */
  isError: boolean
  onRetry: () => void
  onCitationClick: (c: ParsedCitation) => void
}

export function LayoutCarnet({ notes, isError, onRetry, onCitationClick }: LayoutCarnetProps) {
  const t = useTranslations("research.carnet")
  const tCommon = useTranslations("common")
  const exportCopy = useNoteExportCopy()

  // Ids present in this carnet — a note-link pill greys out when its target is
  // absent, and scrolls to the entry's anchor when present (no view switch).
  const knownNoteIds = useMemo(() => new Set((notes ?? []).map((n) => n.id)), [notes])
  const scrollToEntry = (noteId: string) => {
    document.getElementById(noteId)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const isLoading = notes === undefined && !isError

  return (
    <div className="flex h-full">
      {/* Sidebar TOC */}
      <aside className="w-64 shrink-0 border-r overflow-y-auto p-4 space-y-1">
        <p className="mono-eyebrow mb-3 block">{t("title")}</p>
        {(notes ?? []).map((note) => (
          <a
            key={note.id}
            href={`#${note.id}`}
            className="block text-sm text-muted-foreground hover:text-foreground truncate py-0.5"
          >
            {note.title}
          </a>
        ))}
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (notes === undefined) return
                downloadMarkdown("carnet-de-recherche.md", notesToMarkdown(notes, exportCopy))
              }}
              // Only a complete carnet is exported (found bug B5's rule): never
              // while a note is loading or failed to load.
              disabled={notes === undefined || notes.length === 0 || isError}
            >
              <Download className="mr-2 h-4 w-4" />
              {t("export")}
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : isError || notes === undefined ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-destructive">{t("exportBlocked")}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                {tCommon("tryAgain")}
              </Button>
            </div>
          ) : notes.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
          ) : (
            <div className="space-y-8">
              {notes.map((note, i) => (
                <div key={note.id}>
                  <CarnetEntry
                    note={note}
                    onCitationClick={onCitationClick}
                    onNoteLinkClick={scrollToEntry}
                    knownNoteIds={knownNoteIds}
                  />
                  {i < notes.length - 1 && <Separator className="mt-8" />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
