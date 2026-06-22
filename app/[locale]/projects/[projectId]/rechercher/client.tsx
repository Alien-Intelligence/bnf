"use client"

// app/[locale]/projects/[projectId]/rechercher/client.tsx
// Step 3 "Espace de recherche" client. Mirrors ConstituerClient's shape: a
// fixed-width rail (sessions + artefacts picker + project memory) beside the
// main espace (research chat + artefact reader). Owns the interactive state the
// server can't: active session, which notes are OPEN as tabs, the active tab,
// and the Atelier/Carnet disposition.

import { useEffect, useRef, useState } from "react"
import { Link } from "@/i18n/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useTurnStream } from "@/hooks/api/turn-stream"
import { useNotes, noteKeys } from "@/hooks/api/notes"
import { memoryKeys } from "@/hooks/api/memory"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutSessionsSidebar } from "@/components/layouts/corpus/sessions-sidebar"
import { CardNotesPicker } from "@/components/cards/notes/picker"
import { LayoutResearchEspace } from "@/components/layouts/research/espace"
import { SheetCitationSource } from "@/components/sheets/citations/source"
import { DialogNewNote } from "@/components/dialogs/notes/create"
import { DialogOnboardingResearch } from "@/components/dialogs/onboarding/research"
import { useMarkOnboardingSeen } from "@/hooks/api/onboarding"
import { ONBOARDING_INTRO } from "@/models/onboarding/schema"
import { SESSIONS_RAIL_WIDTH } from "@/lib/constants"
import type { NoteListItem } from "@/models/notes/schema"
import type { AppSession } from "@/models/sessions/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { useTranslations } from "next-intl"

type Disposition = "atelier" | "carnet"

interface RechercherClientProps {
  projectId: string
  locale: string
  projectName: string
  initialUser: { name?: string | null; email: string }
  initialSessionId: string
  initialSessions: AppSession[]
  initialNotes: NoteListItem[]
  isIngested: boolean
  clusterId: string
  docCount: number
  introSeen: boolean
}

export function RechercherClient({
  projectId,
  locale,
  projectName,
  initialUser,
  initialSessionId,
  initialSessions,
  initialNotes,
  isIngested,
  clusterId,
  docCount,
  introSeen,
}: RechercherClientProps) {
  const t = useTranslations("research")

  // ── Active session ────────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId)
  const stream = useTurnStream(activeSessionId)

  // ── Notes (live; seeded from the server) ───────────────────────────────────
  const { data: notes } = useNotes(projectId, { initialData: initialNotes })

  // ── Reader state — open tabs, active tab, disposition ───────────────────────
  // Seed the reader with the most recent note so the espace isn't empty when a
  // project already has artefacts (matches the design's "a note is open").
  const [openNoteIds, setOpenNoteIds] = useState<string[]>(() =>
    initialNotes[0] ? [initialNotes[0].id] : [],
  )
  const [activeNoteId, setActiveNoteId] = useState<string | null>(
    initialNotes[0]?.id ?? null,
  )
  const [disposition, setDisposition] = useState<Disposition>("atelier")

  const openNote = (id: string) => {
    setOpenNoteIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveNoteId(id)
    setDisposition("atelier")
  }

  const closeNote = (id: string) => {
    setOpenNoteIds((prev) => {
      const next = prev.filter((n) => n !== id)
      // If we closed the active tab, fall back to its neighbour.
      setActiveNoteId((active) => {
        if (active !== id) return active
        const idx = prev.indexOf(id)
        return next[idx] ?? next[idx - 1] ?? null
      })
      return next
    })
  }

  // ── Onboarding intro — auto-open once per user; "?" reopens without resetting.
  const [introOpen, setIntroOpen] = useState(!introSeen)
  const markIntroSeen = useMarkOnboardingSeen()
  const onIntroOpenChange = (open: boolean) => {
    setIntroOpen(open)
    if (!open && !introSeen) {
      markIntroSeen.mutate({ intro: ONBOARDING_INTRO.RESEARCH })
    }
  }

  // ── Citation source panel + new-note dialog ─────────────────────────────────
  const [selectedCitation, setSelectedCitation] = useState<ParsedCitation | null>(null)
  const [newNoteOpen, setNewNoteOpen] = useState(false)
  const onCitationClick = (c: ParsedCitation) => setSelectedCitation(c)

  // ── Reconcile on turn finish ────────────────────────────────────────────────
  // The agent authors notes and writes memory mid-turn; the live SSE channel
  // doesn't yet carry a note_event, so — exactly as ConstituerClient does for
  // corpus/memory — refresh the notes list and memory whenever a turn completes
  // (isStreaming true → false). Reliable safety net, no polling.
  const qc = useQueryClient()
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const streaming = stream.isStreaming
    if (prevStreamingRef.current && !streaming) {
      void qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
      void qc.invalidateQueries({ queryKey: memoryKeys.all(projectId, "research") })
    }
    prevStreamingRef.current = streaming
  }, [stream.isStreaming, projectId, qc])

  const user: { name?: string; email: string } = {
    name: initialUser.name ?? undefined,
    email: initialUser.email,
  }

  if (!isIngested) {
    return (
      <div className="flex h-screen flex-col">
        <WorkspaceHeader user={user} projectId={projectId} />
        <div className="flex flex-1 items-center justify-center p-6">
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
    <div className="flex h-screen flex-col">
      <WorkspaceHeader user={user} projectId={projectId} />
      <div className="flex flex-1 overflow-hidden">
        {/* Rail — sessions + artefacts picker + project memory */}
        <div className="shrink-0 overflow-hidden" style={{ width: SESSIONS_RAIL_WIDTH }}>
          <LayoutSessionsSidebar
            projectId={projectId}
            scope="research"
            activeSessionId={activeSessionId}
            onActiveSessionChange={setActiveSessionId}
            initialSessions={initialSessions}
            artefactsSlot={
              <CardNotesPicker
                projectId={projectId}
                activeNoteId={activeNoteId}
                onOpenNote={openNote}
                onNewNote={() => setNewNoteOpen(true)}
                initialNotes={initialNotes}
              />
            }
          />
        </div>

        {/* Main espace */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <LayoutResearchEspace
            projectId={projectId}
            locale={locale}
            projectName={projectName}
            stream={stream}
            notes={notes ?? []}
            openNoteIds={openNoteIds}
            activeNoteId={activeNoteId}
            onActivateNote={setActiveNoteId}
            onCloseNote={closeNote}
            disposition={disposition}
            onDispositionChange={setDisposition}
            clusterId={clusterId}
            docCount={docCount}
            onOpenNewNote={() => setNewNoteOpen(true)}
            onCitationClick={onCitationClick}
            onOpenHelp={() => setIntroOpen(true)}
          />
        </div>
      </div>

      <DialogOnboardingResearch open={introOpen} onOpenChange={onIntroOpenChange} />

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
        onCreated={(noteId) => openNote(noteId)}
      />
    </div>
  )
}
