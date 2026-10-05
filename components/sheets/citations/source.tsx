"use client"

import { useMemo } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { CardSharedLoadError } from "@/components/cards/shared/load-error"
import { ArrowUpRight, BookOpen, Eye, TriangleAlert } from "lucide-react"
import { iiifImageUrl, gallicaItemUrl, gallicaViewerUrl } from "@/lib/citations/external"
// gallicaViewerUrl → IIIF (view3if) viewer; gallicaItemUrl → classic Gallica item page.
import { buildOcrIndex, folioOcrState, ocrPercent, type FolioOcrState } from "@/lib/ocr/quality"
import { CITATION_THUMB_IIIF_SIZE } from "@/lib/constants"
import { useCitationsForArk } from "@/hooks/api/citations"
import { useDocumentOcr } from "@/hooks/api/documents"
import { cn } from "@/lib/utils"
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  OCR_SOURCE,
  type DocumentOcrStatus,
  type DocumentOcrView,
} from "@/models/documents/schema"
import type { CitationUsage } from "@/models/notes/schema"
import { useTranslations } from "next-intl"

interface SheetCitationSourceProps {
  projectId: string
  ark: string | null
  folio: number | null
  label: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
}

export function SheetCitationSource({
  projectId,
  ark,
  folio,
  label,
  open,
  onOpenChange,
}: SheetCitationSourceProps) {
  const t = useTranslations("citations.panel")
  const usagesQuery = useCitationsForArk(projectId, ark)
  const ocrQuery = useDocumentOcr(projectId, ark)
  const usages = usagesQuery.data

  // The exact-folio thumbnail is inlined inside a `hasFolio` guard so TS
  // narrows `folio` to a number.
  const hasFolio = ark != null && folio != null

  // Dedupe by note — a note citing the same ARK on several folios returns one
  // usage row per citation, which previously rendered as N identical lines.
  const otherNotes = useMemo(() => {
    const seen = new Set<string>()
    const out: CitationUsage[] = []
    for (const u of usages ?? []) {
      if (seen.has(u.noteId)) continue
      seen.add(u.noteId)
      out.push(u)
    }
    return out
  }, [usages])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-105 max-w-full flex-col gap-0 overflow-y-auto p-0"
      >
        <SheetHeader className="border-b px-4 py-3">
          <span className="mono-eyebrow text-brand-teal">{t("eyebrow")}</span>
          <SheetTitle className="text-base leading-snug">{label ?? t("title")}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 py-5">
          {/* Thumbnail + folio */}
          {hasFolio ? (
            <div className="flex items-start gap-3.5">
              {/* Plain <img>: a contained IIIF folio thumbnail — no giant hero. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={iiifImageUrl(ark, folio, CITATION_THUMB_IIIF_SIZE)}
                alt={label ?? ""}
                className="h-26 w-20 shrink-0 rounded border bg-muted object-cover"
                loading="lazy"
              />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("folioLabel", { folio })}
                </span>
              </div>
            </div>
          ) : null}

          {/* OCR quality of the cited folio + the document's "Taux OCR" */}
          {ark ? (
            <SectionCitationOcr
              ocr={ocrQuery.data}
              isError={ocrQuery.isError}
              onRetry={() => void ocrQuery.refetch()}
              folio={folio}
            />
          ) : null}

          {/* ARK box */}
          {ark ? (
            <div className="rounded-md border bg-input/20 px-3 py-2.5">
              <div className="mono-eyebrow mb-1 text-neutral-600">{t("arkLabel")}</div>
              <div className="break-all font-mono text-[11.5px] text-brand-teal">{ark}</div>
            </div>
          ) : null}

          {/* Consult on the BnF — IIIF folio viewer is the primary action */}
          {ark ? (
            <div>
              <div className="mono-eyebrow mb-2.5 text-neutral-600">{t("consult")}</div>
              <ConsultActions ark={ark} folio={folio} />
            </div>
          ) : null}

          {/* Other notes citing this ARK. Found bug B4: its loading and error
              states used to be dropped — an error read as "no other note". */}
          <SectionCitationUsages
            isLoading={usagesQuery.isLoading}
            isError={usagesQuery.isError}
            onRetry={() => void usagesQuery.refetch()}
            otherNotes={otherNotes}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

// "Consulter sur la BnF": the exact folio in the IIIF viewer (primary) and in
// Gallica when the citation carries a folio. Folio is mandatory on a citation,
// but a malformed one degrades to the document-level Gallica viewer — never a
// guessed folio.
function ConsultActions({ ark, folio }: { ark: string; folio: number | null }) {
  const t = useTranslations("citations.panel")
  if (folio === null) {
    return (
      <CiteAction
        href={gallicaViewerUrl(ark)}
        icon={<BookOpen className="size-4" strokeWidth={1.8} />}
        title={t("gallicaViewer")}
        subtitle={t("gallicaViewerSub")}
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <CiteAction
        href={gallicaViewerUrl(ark, folio)}
        icon={<Eye className="size-4" strokeWidth={1.8} />}
        title={t("iiifViewer", { folio })}
        subtitle={t("iiifViewerSub")}
        primary
      />
      <CiteAction
        href={gallicaItemUrl(ark, folio)}
        icon={<BookOpen className="size-4" strokeWidth={1.8} />}
        title={t("gallicaViewer")}
        subtitle={t("gallicaViewerSub")}
      />
    </div>
  )
}

// "Utilisé dans d'autres notes" — loading → error → empty (said so) → content.
function SectionCitationUsages({
  isLoading,
  isError,
  onRetry,
  otherNotes,
}: {
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  otherNotes: CitationUsage[]
}) {
  const t = useTranslations("citations.panel")
  if (isLoading) {
    return (
      <>
        <Separator />
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </>
    )
  }
  if (isError) {
    return (
      <>
        <Separator />
        <CardSharedLoadError layout="inline" message={t("usagesLoadError")} onRetry={onRetry} />
      </>
    )
  }
  if (otherNotes.length === 0) {
    return (
      <>
        <Separator />
        <p className="text-sm text-muted-foreground">{t("usagesNone")}</p>
      </>
    )
  }
  return (
    <>
      <Separator />
      <div>
        <p className="mb-2 text-sm font-medium">{t("usages")}</p>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {otherNotes.map((u) => (
            <li key={u.noteId} className="truncate">
              {u.noteTitle}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

// The "Qualité OCR" block (feedback 2026-09-29 #7): the cited folio's OCR
// state (lib/ocr/quality.ts) — what produced its text and, for BnF ALTO, its
// measured quality with the low marker — plus the document's "Taux OCR". A
// folio whose quality is not known says why in its own words (not yet,
// suspended, never for this folio…): never read as "not low".
//
// error → loading → content. "Loading" is any state without data and without
// an error — a fetch in flight, or a query disabled while the sheet animates
// closed — so a closing sheet never flashes a false error.
function SectionCitationOcr({
  ocr,
  isError,
  onRetry,
  folio,
}: {
  ocr: DocumentOcrView | undefined
  isError: boolean
  onRetry: () => void
  folio: number | null
}) {
  const t = useTranslations("citations.ocr")

  if (isError) {
    return <CardSharedLoadError layout="inline" message={t("loadError")} onRetry={onRetry} />
  }
  if (ocr === undefined) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  const index = buildOcrIndex(
    ocr.folios,
    ocr.status === DOCUMENT_OCR_STATUS.PENDING ? [] : [{ ark: ocr.ark, status: ocr.status }],
  )
  const state = folioOcrState(index, ocr.ark, folio)
  const low = state.kind === FOLIO_OCR_STATE.RECORDED && state.view.low

  return (
    <div>
      <div className="mono-eyebrow mb-1.5 text-neutral-600">{t("sheetTitle")}</div>
      <p className="text-[12.5px] text-foreground">{folioOcrLine(state, t)}</p>
      {low && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning">
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
          {t("lowFolio")}
        </p>
      )}
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
        {ocr.ocrRate === null ? t("noRate") : t("docRate", { rate: ocrPercent(ocr.ocrRate) })}
      </p>
    </div>
  )
}

/** The message key of each document status under which a folio's quality is unknown. */
const STATUS_LINE_KEY: Record<Exclude<DocumentOcrStatus, typeof DOCUMENT_OCR_STATUS.AVAILABLE>, string> = {
  [DOCUMENT_OCR_STATUS.PENDING]: "statusPending",
  [DOCUMENT_OCR_STATUS.BUILDING]: "statusBuilding",
  [DOCUMENT_OCR_STATUS.INCOMPATIBLE]: "statusIncompatible",
  [DOCUMENT_OCR_STATUS.UNAVAILABLE]: "statusUnavailable",
  [DOCUMENT_OCR_STATUS.QUARANTINED]: "statusQuarantined",
}

/** The one-line description of a folio's OCR state, distinct for every state. */
function folioOcrLine(
  state: FolioOcrState,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (state.kind === FOLIO_OCR_STATE.NO_FOLIO) return t("unavailable")
  if (state.kind === FOLIO_OCR_STATE.PENDING || state.kind === FOLIO_OCR_STATE.UNAVAILABLE) {
    return t(STATUS_LINE_KEY[state.status])
  }
  if (state.kind === FOLIO_OCR_STATE.NOT_RECORDED) return t("folioNotRecorded")
  if (state.kind === FOLIO_OCR_STATE.CORPUS_REVOKED) return t("corpusRevoked")
  if (state.kind === FOLIO_OCR_STATE.CHECK_FAILED) return t("loadError")
  const { view } = state
  if (view.ocrSource === OCR_SOURCE.MISTRAL) return t("folioMistral")
  if (view.ocrSource === OCR_SOURCE.VISION) return t("folioVision")
  if (view.ocrQuality === null || view.wordCount === null) return t("folioAltoUnscored")
  return t("folioAlto", { quality: ocrPercent(view.ocrQuality), words: view.wordCount })
}

// A rich external-link row. `primary` gives the teal-highlighted treatment the
// design uses for the exact-folio viewer (the first, default action).
function CiteAction({
  href,
  icon,
  title,
  subtitle,
  primary = false,
}: {
  href: string
  icon: React.ReactNode
  title: string
  subtitle: string
  primary?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors",
        primary
          ? "border-brand-teal/35 bg-brand-teal/8 hover:bg-brand-teal/15"
          : "hover:border-neutral-600",
      )}
    >
      <span className={cn("shrink-0", primary ? "text-brand-teal" : "text-neutral-300")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-foreground">{title}</span>
        <span className="block text-[10.5px] text-muted-foreground">{subtitle}</span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
    </a>
  )
}
