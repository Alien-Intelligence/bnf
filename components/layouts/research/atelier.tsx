"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button, buttonVariants } from "@/components/ui/button"
import { Plus } from "lucide-react"
import { Link } from "@/i18n/navigation"
import { LayoutCorpusChat } from "@/components/layouts/corpus/chat"
import { NoteTab } from "@/components/cards/notes/tab"
import { useTranslations } from "next-intl"
import type { ParsedCitation } from "@/lib/citations/syntax"
import type { UseTurnStreamResult } from "@/hooks/api/turn-stream"

interface NoteListItem {
  id: string
  title: string
}

interface LayoutAtelierProps {
  projectId: string
  locale: string
  stream: UseTurnStreamResult
  notes: NoteListItem[]
  activeNoteId: string | null
  onActiveNoteChange: (id: string) => void
  onOpenNewNote: () => void
  onCitationClick: (c: ParsedCitation) => void
}

export function LayoutAtelier({
  projectId,
  locale,
  stream,
  notes,
  activeNoteId,
  onActiveNoteChange,
  onOpenNewNote,
  onCitationClick,
}: LayoutAtelierProps) {
  const t = useTranslations("research.atelier")

  return (
    <div className="grid grid-cols-[2fr_3fr] h-full divide-x">
      {/* Chat panel — 40% */}
      <div className="flex flex-col overflow-hidden">
        <LayoutCorpusChat
          stream={stream}
          projectId={projectId}
          locale={locale}
        />
      </div>

      {/* Notes panel — 60% */}
      <div className="flex flex-col overflow-hidden">
        {notes.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground p-6">
            <p className="text-sm">{t("noNotes")}</p>
            <Button variant="outline" size="sm" onClick={onOpenNewNote}>
              <Plus className="mr-2 h-4 w-4" />
              {t("newNote")}
            </Button>
          </div>
        ) : (
          <Tabs
            value={activeNoteId ?? notes[0]?.id}
            onValueChange={onActiveNoteChange}
            className="flex flex-col h-full"
          >
            <div className="flex items-center border-b px-2 gap-1 shrink-0">
              <TabsList className="h-10 rounded-none bg-transparent border-0 p-0 flex-1 justify-start overflow-x-auto">
                {notes.map((note) => (
                  <TabsTrigger
                    key={note.id}
                    value={note.id}
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none text-xs max-w-[160px] truncate"
                  >
                    {note.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={onOpenNewNote}
                  title={t("newNote")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Link
                  href={`/projects/${projectId}/rechercher/carnet`}
                  className={buttonVariants({ variant: "ghost", size: "sm" }) + " text-xs"}
                >
                  {t("viewInCarnet")}
                </Link>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {notes.map((note) => (
                <TabsContent
                  key={note.id}
                  value={note.id}
                  className="h-full mt-0 overflow-y-auto"
                >
                  <NoteTab
                    noteId={note.id}
                    onCitationClick={onCitationClick}
                  />
                </TabsContent>
              ))}
            </div>
          </Tabs>
        )}
      </div>
    </div>
  )
}
