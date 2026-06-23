"use client"

import { CarnetEntry } from "@/components/cards/notes/carnet-entry"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { notesToMarkdown, downloadMarkdown } from "@/lib/notes/export"

interface Note {
  id: string
  title: string
  body_md: string | null
  createdAt: Date | string
}

interface LayoutCarnetProps {
  notes: Note[]
  onCitationClick: (c: ParsedCitation) => void
}

export function LayoutCarnet({ notes, onCitationClick }: LayoutCarnetProps) {
  const t = useTranslations("research.carnet")

  return (
    <div className="flex h-full">
      {/* Sidebar TOC */}
      <aside className="w-64 shrink-0 border-r overflow-y-auto p-4 space-y-1">
        <p className="mono-eyebrow mb-3 block">{t("title")}</p>
        {notes.map((note) => (
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
              onClick={() => downloadMarkdown("carnet-de-recherche.md", notesToMarkdown(notes))}
              disabled={notes.length === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              {t("export")}
            </Button>
          </div>

          {notes.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
          ) : (
            <div className="space-y-8">
              {notes.map((note, i) => (
                <div key={note.id}>
                  <CarnetEntry note={note} onCitationClick={onCitationClick} />
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
