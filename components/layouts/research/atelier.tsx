"use client"

import { FileText, HelpCircle, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button, buttonVariants } from "@/components/ui/button"
import { Link } from "@/i18n/navigation"
import { LayoutCorpusChat } from "@/components/layouts/corpus/chat"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import { NoteTab } from "@/components/cards/notes/tab"
import { ROUTES } from "@/lib/constants"
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
  onOpenHelp: () => void
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
  onOpenHelp,
}: LayoutAtelierProps) {
  const t = useTranslations("research.atelier")
  const tChat = useTranslations("research.chat")
  const tResearch = useTranslations("research")

  return (
    <div className="grid h-full grid-cols-[2fr_3fr] divide-x">
      {/* Chat panel — 40% (reuses the corpus chat with research agent copy) */}
      <div className="flex flex-col overflow-hidden">
        <LayoutCorpusChat
          stream={stream}
          projectId={projectId}
          locale={locale}
          headerSubtitle={tChat("subtitle")}
          introText={tChat("intro")}
          placeholder={tChat("placeholder")}
        />
      </div>

      {/* Notes panel — 60% */}
      <div className="flex flex-col overflow-hidden">
        {notes.length === 0 ? (
          <LayoutSharedEmptyState
            icon={FileText}
            title={t("noNotes")}
            action={
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onOpenNewNote}>
                  <Plus className="size-4" />
                  {t("newNote")}
                </Button>
                <Button variant="ghost" size="sm" onClick={onOpenHelp}>
                  <HelpCircle className="size-4" />
                  {tResearch("help")}
                </Button>
              </div>
            }
          />
        ) : (
          <Tabs
            value={activeNoteId ?? notes[0]?.id}
            onValueChange={onActiveNoteChange}
            className="flex h-full flex-col"
          >
            <div className="flex shrink-0 items-center gap-1 border-b px-2">
              <TabsList className="h-10 flex-1 justify-start overflow-x-auto rounded-none border-0 bg-transparent p-0">
                {notes.map((note) => (
                  <TabsTrigger
                    key={note.id}
                    value={note.id}
                    className="max-w-[160px] truncate rounded-none border-b-2 border-transparent text-xs data-[state=active]:border-primary data-[state=active]:shadow-none"
                  >
                    {note.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={onOpenNewNote}
                  title={t("newNote")}
                >
                  <Plus className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={onOpenHelp}
                  title={tResearch("help")}
                >
                  <HelpCircle className="size-4" />
                </Button>
                <Link
                  href={ROUTES.carnet(projectId)}
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
                  className="mt-0 h-full overflow-y-auto"
                >
                  <NoteTab noteId={note.id} onCitationClick={onCitationClick} />
                </TabsContent>
              ))}
            </div>
          </Tabs>
        )}
      </div>
    </div>
  )
}
