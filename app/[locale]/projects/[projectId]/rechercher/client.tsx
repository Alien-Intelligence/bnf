"use client"

import { useState } from "react"
import { Link } from "@/i18n/navigation"
import { useTurnStream } from "@/hooks/api/turn-stream"
import { useNotes } from "@/hooks/api/notes"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutAtelier } from "@/components/layouts/research/atelier"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import { DialogNewNote } from "@/components/dialogs/notes/create"
import type { NoteListItem } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { useTranslations } from "next-intl"

interface RechercherClientProps {
  projectId: string
  locale: string
  initialUser: { name?: string | null; email: string }
  initialSessionId: string
  initialNotes: NoteListItem[]
  isIngested: boolean
}

export function RechercherClient({
  projectId,
  locale,
  initialUser,
  initialSessionId,
  initialNotes,
  isIngested,
}: RechercherClientProps) {
  const t = useTranslations("research")

  const [activeNoteId, setActiveNoteId] = useState<string | null>(
    initialNotes[0]?.id ?? null,
  )
  const [selectedCitation, setSelectedCitation] =
    useState<ParsedCitation | null>(null)
  const [newNoteOpen, setNewNoteOpen] = useState(false)

  const stream = useTurnStream(initialSessionId)

  // Keep the notes list live — seeded from the server-rendered initial data.
  const { data: notes } = useNotes(projectId, { initialData: initialNotes })

  const onCitationClick = (c: ParsedCitation) => setSelectedCitation(c)

  const user: { name?: string; email: string } = {
    name: initialUser.name ?? undefined,
    email: initialUser.email,
  }

  if (!isIngested) {
    return (
      <div className="flex flex-col h-screen">
        <WorkspaceHeader user={user} />
        <div className="flex-1 flex items-center justify-center p-6">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>{t("notIngested.title")}</CardTitle>
              <CardDescription>{t("notIngested.body")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href={`/projects/${projectId}/ingerer`}
                className={buttonVariants()}
              >
                {t("notIngested.openIngest")}
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader user={user} />
      <div className="flex-1 overflow-hidden">
        <LayoutAtelier
          projectId={projectId}
          locale={locale}
          stream={stream}
          notes={notes ?? []}
          activeNoteId={activeNoteId}
          onActiveNoteChange={setActiveNoteId}
          onOpenNewNote={() => setNewNoteOpen(true)}
          onCitationClick={onCitationClick}
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

      <DialogNewNote
        open={newNoteOpen}
        onOpenChange={setNewNoteOpen}
        projectId={projectId}
        onCreated={(noteId) => setActiveNoteId(noteId)}
      />
    </div>
  )
}
