"use client"

// components/layouts/research/carnet.tsx
// LayoutCarnet — the standalone Carnet page: a TOC rail and every note of the
// project stitched front to back. The note set and each note load
// independently (CarnetClient, found bug B8), so the layout renders explicit
// states (playbook/ui-states.md): the list is loading / failed / empty /
// ready, and inside a ready list each entry is loading / failed (retry that
// note) / ready. The export is offered only when every entry is ready — a
// partial carnet is never exported (found bug B5's rule).

import { useMemo } from "react"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import { CarnetEntry } from "@/components/cards/notes/carnet-entry"
import { CardSharedLoadError } from "@/components/cards/shared/load-error"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { CARNET_EXPORT_FILENAME } from "@/lib/constants"
import { downloadMarkdown, notesToMarkdown } from "@/lib/notes/export"
import { useNoteExportCopy } from "@/lib/notes/export-copy"
import type { NoteDetail } from "@/models/notes/schema"

/** One note of the carnet. */
export type CarnetEntryState =
  | { kind: "loading" }
  | { kind: "error"; retry: () => void }
  | { kind: "ready"; note: NoteDetail }

/** The carnet's note set. */
export type CarnetListState =
  | { kind: "loading" }
  | { kind: "error"; retry: () => void }
  | {
      kind: "ready"
      entries: Array<{ id: string; title: string; state: CarnetEntryState }>
    }

interface LayoutCarnetProps {
  list: CarnetListState
  onCitationClick: (c: ParsedCitation) => void
}

/** Rows of the TOC rail while the note set loads. */
const TOC_SKELETON_ROWS = 5

export function LayoutCarnet({ list, onCitationClick }: LayoutCarnetProps) {
  const t = useTranslations("research.carnet")
  const exportCopy = useNoteExportCopy()

  const entries = list.kind === "ready" ? list.entries : []
  // Ids present in this carnet — a note-link pill greys out when its target is
  // absent, and scrolls to the entry's anchor when present (no view switch).
  const knownNoteIds = useMemo(
    () => new Set(list.kind === "ready" ? list.entries.map((e) => e.id) : []),
    [list],
  )
  const readyNotes = entries.flatMap((e) => (e.state.kind === "ready" ? [e.state.note] : []))
  const exportable = list.kind === "ready" && entries.length > 0 && readyNotes.length === entries.length

  const scrollToEntry = (noteId: string) => {
    document.getElementById(noteId)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="flex h-full">
      {/* Sidebar TOC */}
      <aside className="w-64 shrink-0 border-r overflow-y-auto p-4 space-y-1">
        <p className="mono-eyebrow mb-3 block">{t("title")}</p>
        <CarnetToc list={list} />
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadMarkdown(CARNET_EXPORT_FILENAME, notesToMarkdown(readyNotes, exportCopy))}
              disabled={!exportable}
              title={exportable ? undefined : t("exportPartial")}
            >
              <Download className="mr-2 h-4 w-4" />
              {t("export")}
            </Button>
          </div>

          <CarnetBody
            list={list}
            knownNoteIds={knownNoteIds}
            onCitationClick={onCitationClick}
            onNoteLinkClick={scrollToEntry}
          />
        </div>
      </div>
    </div>
  )
}

function CarnetToc({ list }: { list: CarnetListState }) {
  if (list.kind === "loading") {
    return (
      <div className="space-y-2 py-0.5">
        {Array.from({ length: TOC_SKELETON_ROWS }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    )
  }
  if (list.kind === "error") return null
  return (
    <>
      {list.entries.map((e) => (
        <a
          key={e.id}
          href={`#${e.id}`}
          className="block text-sm text-muted-foreground hover:text-foreground truncate py-0.5"
        >
          {e.title}
        </a>
      ))}
    </>
  )
}

function CarnetBody({
  list,
  knownNoteIds,
  onCitationClick,
  onNoteLinkClick,
}: {
  list: CarnetListState
  knownNoteIds: ReadonlySet<string>
  onCitationClick: (c: ParsedCitation) => void
  onNoteLinkClick: (noteId: string) => void
}) {
  const t = useTranslations("research.carnet")

  if (list.kind === "loading") {
    return (
      <div className="space-y-8">
        <CarnetEntrySkeleton />
        <CarnetEntrySkeleton />
      </div>
    )
  }
  if (list.kind === "error") {
    return <CardSharedLoadError layout="block" message={t("loadListError")} onRetry={list.retry} />
  }
  if (list.entries.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("empty")}</p>
  }
  return (
    <div className="space-y-8">
      {list.entries.map((e, i) => (
        <div key={e.id} id={e.id} className="scroll-mt-4">
          <CarnetEntrySlot
            title={e.title}
            state={e.state}
            knownNoteIds={knownNoteIds}
            onCitationClick={onCitationClick}
            onNoteLinkClick={onNoteLinkClick}
          />
          {i < list.entries.length - 1 && <Separator className="mt-8" />}
        </div>
      ))}
    </div>
  )
}

function CarnetEntrySlot({
  title,
  state,
  knownNoteIds,
  onCitationClick,
  onNoteLinkClick,
}: {
  title: string
  state: CarnetEntryState
  knownNoteIds: ReadonlySet<string>
  onCitationClick: (c: ParsedCitation) => void
  onNoteLinkClick: (noteId: string) => void
}) {
  const t = useTranslations("research.carnet")
  if (state.kind === "loading") return <CarnetEntrySkeleton />
  if (state.kind === "error") {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-4">{title}</h2>
        <CardSharedLoadError layout="inline" message={t("loadError")} onRetry={state.retry} />
      </div>
    )
  }
  return (
    <CarnetEntry
      note={state.note}
      onCitationClick={onCitationClick}
      onNoteLinkClick={onNoteLinkClick}
      knownNoteIds={knownNoteIds}
    />
  )
}

/** Mirrors CarnetEntry: title, date line, a few body lines. */
function CarnetEntrySkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="mb-4 h-3 w-28" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}
