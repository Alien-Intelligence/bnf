"use client"

// app/[locale]/projects/[projectId]/rechercher/client.tsx
// Step 3 "Espace de recherche" client. Mirrors ConstituerClient's shape: a
// fixed-width rail (sessions + artefacts picker + project memory) beside the
// main espace (research chat + artefact reader). Owns the interactive state the
// server can't: active session, which notes are OPEN as tabs, the active tab,
// and the Atelier/Carnet disposition.

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "@/i18n/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useTurnStream } from "@/hooks/api/turn-stream"
import { useNotes, noteKeys } from "@/hooks/api/notes"
import { memoryKeys } from "@/hooks/api/memory"
import { sessionKeys } from "@/hooks/api/sessions"
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

  const openNote = useCallback((id: string) => {
    setOpenNoteIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveNoteId(id)
    setDisposition("atelier")
  }, [])

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

  const qc = useQueryClient()

  // ── Auto-open notes the agent writes ─────────────────────────────────────────
  // When a note_create / note_update tool resolves it emits a note_event on the
  // live stream. As each one arrives we refresh the notes list (so the new/edited
  // body is loaded) and open the note in the reader — the librarian sees the
  // agent's work appear without hunting for it. domainEvents accumulates and
  // resets to [] on session change, so the cursor resyncs when it shrinks.
  const processedNoteEventsRef = useRef(0)
  useEffect(() => {
    const events = stream.domainEvents
    if (events.length < processedNoteEventsRef.current) processedNoteEventsRef.current = 0
    if (events.length === processedNoteEventsRef.current) return

    const fresh = events.slice(processedNoteEventsRef.current)
    processedNoteEventsRef.current = events.length

    // Narrowing loop (not filter/map) so the discriminated union resolves to the
    // note_event variant and `data.noteId` is typed.
    const noteIds: string[] = []
    for (const e of fresh) {
      if (e.type === "note_event") noteIds.push(e.data.noteId)
    }
    if (noteIds.length === 0) return

    void qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
    // Open each in arrival order; the last becomes the active tab.
    noteIds.forEach(openNote)
  }, [stream.domainEvents, projectId, qc, openNote])

  // ── Reconcile on turn finish ────────────────────────────────────────────────
  // Memory writes have no live reconciliation here, and the notes list is
  // refreshed again as a safety net (covers any note_event missed mid-stream)
  // whenever a turn completes (isStreaming true → false).
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const streaming = stream.isStreaming
    if (prevStreamingRef.current && !streaming) {
      void qc.invalidateQueries({ queryKey: noteKeys.list(projectId) })
      void qc.invalidateQueries({ queryKey: memoryKeys.all(projectId, "research") })
      // A session's first turn auto-names it server-side — pull the new title.
      void qc.invalidateQueries({ queryKey: sessionKeys.list(projectId, "research") })
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
