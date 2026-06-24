"use client"

// components/layouts/research/espace.tsx
// LayoutResearchEspace — the Step 3 "Espace de recherche" main area (prototype
// lines 575-684). A sub-header (cluster label + Atelier/Carnet disposition
// toggle) sits above a split: the research chat at 40% (left) and the artefact
// reader at 60% (right). The reader shows either the open-note tabs (Atelier) or
// the stitched research journal (Carnet), driven by `disposition`.
//
// The artefacts LIST lives in the rail (CardNotesPicker); here the reader only
// shows notes the user has OPENED, as closable tabs — the design's tab model.

import { Download, FileText, HelpCircle, NotebookText, PenLine, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { LayoutCorpusChat } from "@/components/layouts/corpus/chat"
import { NoteBody } from "@/components/cards/notes/note-body"
import { FeedbackButton } from "@/components/cards/feedback/feedback-button"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { useNote, useNoteDetails } from "@/hooks/api/notes"
import {
  noteToMarkdown,
  notesToMarkdown,
  downloadMarkdown,
  filenameFromTitle,
} from "@/lib/notes/export"
import { formatRelativeFr } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { NoteListItem } from "@/models/notes/schema"
import type { ParsedCitation } from "@/lib/citations/syntax"
import type { UseTurnStreamResult } from "@/hooks/api/turn-stream"
import type { AgentProvider } from "@/lib/constants"

type Disposition = "atelier" | "carnet"

interface LayoutResearchEspaceProps {
  projectId: string
  locale: string
  projectName: string
  stream: UseTurnStreamResult
  /** Active durable session id — anchors the session-level feedback button in
   *  the research chat header. */
  appSessionId?: string | null
  notes: NoteListItem[]
  openNoteIds: string[]
  activeNoteId: string | null
  onActivateNote: (id: string) => void
  onCloseNote: (id: string) => void
  disposition: Disposition
  onDispositionChange: (d: Disposition) => void
  clusterId: string
  docCount: number
  onOpenNewNote: () => void
  onCitationClick: (c: ParsedCitation) => void
  onOpenHelp: () => void
  /** Model selector wiring, forwarded to the research chat panel (openrouter
   *  only). See LayoutCorpusChat. */
  agentProvider?: AgentProvider
  selectedModel?: string
  onModelChange?: (id: string) => void
}

export function LayoutResearchEspace({
  projectId,
  locale,
  projectName,
  stream,
  appSessionId,
  notes,
  openNoteIds,
  activeNoteId,
  onActivateNote,
  onCloseNote,
  disposition,
  onDispositionChange,
  clusterId,
  docCount,
  onOpenNewNote,
  onCitationClick,
  onOpenHelp,
  agentProvider,
  selectedModel,
  onModelChange,
}: LayoutResearchEspaceProps) {
  const t = useTranslations("research.espace")
  const tChat = useTranslations("research.chat")

  const ragLabel = `${clusterId} · ${t("docs", { count: docCount })}`

  return (
    <div className="flex h-full flex-col">
      {/* ── Espace sub-header ───────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[13.5px] font-semibold">{t("title")}</span>
          <button
            type="button"
            onClick={onOpenHelp}
            title={t("title")}
            aria-label={t("title")}
            className="flex size-5.5 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:border-brand-teal/45 hover:text-brand-teal"
          >
            <HelpCircle className="size-3.5" />
          </button>
          <span className="font-mono text-[11px] text-muted-foreground">{ragLabel}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="mono-eyebrow">{t("disposition")}</span>
          <div className="flex overflow-hidden rounded-md border">
            <DispositionButton
              active={disposition === "atelier"}
              onClick={() => onDispositionChange("atelier")}
            >
              {t("atelier")}
            </DispositionButton>
            <DispositionButton
              active={disposition === "carnet"}
              onClick={() => onDispositionChange("carnet")}
            >
              {t("carnet")}
            </DispositionButton>
          </div>
        </div>
      </div>

      {/* ── Split: chat 40% (left) · reader 60% (right) ─────────────────── */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-2/5 min-w-[22.5rem] max-w-[35rem] flex-col overflow-hidden border-r">
          <LayoutCorpusChat
            stream={stream}
            projectId={projectId}
            locale={locale}
            appSessionId={appSessionId}
            headerTitle={t("openSource")}
            headerSubtitle={t("openSubtitle")}
            introText={tChat("intro")}
            placeholder={tChat("placeholder")}
            agentProvider={agentProvider}
            selectedModel={selectedModel}
            onModelChange={onModelChange}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {disposition === "carnet" ? (
            <ReaderCarnet
              notes={notes}
              projectName={projectName}
              onCitationClick={onCitationClick}
            />
          ) : (
            <ReaderAtelier
              projectId={projectId}
              notes={notes}
              openNoteIds={openNoteIds}
              activeNoteId={activeNoteId}
              onActivateNote={onActivateNote}
              onCloseNote={onCloseNote}
              onOpenNewNote={onOpenNewNote}
              onCitationClick={onCitationClick}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Disposition toggle button ──────────────────────────────────────────────

function DispositionButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

// ── Atelier reader — open notes as closable tabs + active note ──────────────

interface ReaderAtelierProps {
  projectId: string
  notes: NoteListItem[]
  openNoteIds: string[]
  activeNoteId: string | null
  onActivateNote: (id: string) => void
  onCloseNote: (id: string) => void
  onOpenNewNote: () => void
  onCitationClick: (c: ParsedCitation) => void
}

function ReaderAtelier({
  projectId,
  notes,
  openNoteIds,
  activeNoteId,
  onActivateNote,
  onCloseNote,
  onOpenNewNote,
  onCitationClick,
}: ReaderAtelierProps) {
  const t = useTranslations("research")
  const tAtelier = useTranslations("research.atelier")

  const titleFor = (id: string) =>
    notes.find((n) => n.id === id)?.title ?? tAtelier("noteTab")

  if (openNoteIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <FileText className="size-7 text-neutral-600" strokeWidth={1.6} aria-hidden />
        <p className="max-w-xs text-sm text-muted-foreground">{t("espace.emptyReader")}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenNewNote}>
            {tAtelier("newNote")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex h-10.5 shrink-0 items-center gap-0.5 overflow-x-auto border-b pl-3.5 pr-2">
        {openNoteIds.map((id) => {
          const isActive = id === activeNoteId
          return (
            <span
              key={id}
              className={cn(
                "flex shrink-0 items-center gap-1 border-b-2 pl-1 transition-colors",
                isActive ? "border-primary" : "border-transparent",
              )}
            >
              <button
                type="button"
                onClick={() => onActivateNote(id)}
                className={cn(
                  "flex max-w-[10rem] items-center gap-1.5 truncate py-2.5 text-xs",
                  isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <FileText className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{titleFor(id)}</span>
              </button>
              <button
                type="button"
                onClick={() => onCloseNote(id)}
                title={tAtelier("closeTab")}
                aria-label={tAtelier("closeTab")}
                className="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-2.5" strokeWidth={2.4} />
              </button>
            </span>
          )
        })}
      </div>

      {/* Active note */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeNoteId ? (
          <NoteReader
            projectId={projectId}
            noteId={activeNoteId}
            onCitationClick={onCitationClick}
          />
        ) : null}
      </div>
    </div>
  )
}

// ── Single artefact reader (artefact eyebrow + title + meta + body) ─────────

function NoteReader({
  projectId,
  noteId,
  onCitationClick,
}: {
  projectId: string
  noteId: string
  onCitationClick: (c: ParsedCitation) => void
}) {
  const t = useTranslations("research.atelier")
  const { data: note, isLoading, isError, refetch } = useNote(noteId)

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[42.5rem] space-y-3 px-10 py-8">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    )
  }

  if (isError || !note) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center text-muted-foreground">
        <p className="text-sm">{t("loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  const citeCount = note.citations.length

  return (
    <div className="px-10 pb-16 pt-7">
      <div className="mx-auto max-w-[42.5rem]">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-brand-teal">
            <PenLine className="size-3.5" strokeWidth={1.8} aria-hidden />
            {t("artefactHeader")}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-mono text-[10.5px] text-neutral-600">
              {t("cites", { count: citeCount })}
            </span>
            <FeedbackButton projectId={projectId} target="note" targetId={note.id} />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadMarkdown(
                  filenameFromTitle(note.title, "note"),
                  noteToMarkdown(note),
                )
              }
              className="h-7 gap-1.5 text-[11.5px]"
            >
              <Download className="size-3.5" strokeWidth={1.8} />
              {t("export")}
            </Button>
          </div>
        </div>
        <h1 className="mb-1 mt-2.5 text-[25px] font-semibold tracking-tight">{note.title}</h1>
        <div className="mb-5 font-mono text-[11.5px] text-muted-foreground">
          {formatRelativeFr(note.updatedAt)}
        </div>
        <NoteBody body={note.body_md ?? ""} onCitationClick={onCitationClick} />
      </div>
    </div>
  )
}

// ── Carnet reader — every note stitched into one document ───────────────────

function ReaderCarnet({
  notes,
  projectName,
  onCitationClick,
}: {
  notes: NoteListItem[]
  projectName: string
  onCitationClick: (c: ParsedCitation) => void
}) {
  const t = useTranslations("research.carnet")
  const results = useNoteDetails(notes.map((n) => n.id))

  const loaded = results
    .map((r) => r.data)
    .filter((n): n is NonNullable<typeof n> => Boolean(n))

  const onExport = () => {
    downloadMarkdown("carnet-de-recherche.md", notesToMarkdown(loaded))
  }

  // Clicking a TOC row scrolls its stitched section into view (smoothly) within
  // the carnet's own scroll area — no URL hash mutation.
  const scrollToSection = (noteId: string) => {
    document
      .getElementById(carnetSectionId(noteId))
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Compiled-journal header */}
      <div className="flex h-10.5 shrink-0 items-center justify-between border-b px-5.5">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">
          <NotebookText className="size-3.5" strokeWidth={1.8} aria-hidden />
          {t("compiledHeader", { count: notes.length })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          disabled={loaded.length === 0}
          className="h-7 gap-1.5 text-[11.5px]"
        >
          <Download className="size-3.5" strokeWidth={1.8} />
          {t("export")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-20 pt-8">
        {notes.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="mx-auto max-w-[42.5rem]">
            {/* Project header + TOC */}
            <div className="mb-7 border-b pb-6">
              <div className="font-mono text-[10.5px] uppercase tracking-wide text-brand-teal">
                {t("projectEyebrow")}
              </div>
              <h1 className="mb-3.5 mt-2 text-[27px] font-semibold tracking-tight">{projectName}</h1>
              <div className="flex flex-col gap-1.5">
                {notes.map((n, i) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => scrollToSection(n.id)}
                    title={n.title}
                    className="group flex items-baseline gap-2.5 text-left text-[13px] text-neutral-300 transition-colors hover:text-foreground"
                  >
                    <span className="w-5.5 shrink-0 font-mono text-[11px] text-neutral-600 group-hover:text-brand-teal">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate group-hover:underline">
                      {n.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                      {n.citationCount}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Stitched notes */}
            {results.map((r, i) => (
              <CarnetSection
                key={notes[i].id}
                sectionId={carnetSectionId(notes[i].id)}
                index={i}
                fallbackTitle={notes[i].title}
                note={r.data}
                isLoading={r.isLoading}
                onCitationClick={onCitationClick}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Stable DOM id for a carnet section, shared by the TOC scroll target and the
 *  section element. Prefixed so it can't collide with other ids on the page. */
function carnetSectionId(noteId: string): string {
  return `carnet-${noteId}`
}

function CarnetSection({
  sectionId,
  index,
  fallbackTitle,
  note,
  isLoading,
  onCitationClick,
}: {
  sectionId: string
  index: number
  fallbackTitle: string
  note: { title: string; body_md: string | null; updatedAt: Date | string } | undefined
  isLoading: boolean
  onCitationClick: (c: ParsedCitation) => void
}) {
  return (
    <section id={sectionId} className={cn("scroll-mt-6", index > 0 && "mt-9 border-t pt-7")}>
      <div className="mb-1 flex items-baseline gap-2.5">
        <span className="font-mono text-xs text-neutral-600">{String(index + 1).padStart(2, "0")}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {note ? formatRelativeFr(note.updatedAt) : ""}
        </span>
      </div>
      <h2 className="mb-3 text-xl font-semibold">{note?.title ?? fallbackTitle}</h2>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : (
        <NoteBody body={note?.body_md ?? ""} onCitationClick={onCitationClick} />
      )}
    </section>
  )
}
