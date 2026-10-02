"use client"

import { useMemo } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowUpRight, BookOpen, Eye, TriangleAlert } from "lucide-react"
import { iiifImageUrl, gallicaItemUrl, gallicaViewerUrl } from "@/lib/citations/external"
// gallicaViewerUrl → IIIF (view3if) viewer; gallicaItemUrl → classic Gallica item page.
import { ocrPercent } from "@/lib/citations/ocr"
import { useCitationsForArk } from "@/hooks/api/citations"
import { useDocumentOcr } from "@/hooks/api/documents"
import { cn } from "@/lib/utils"
import { OCR_SOURCE, type DocumentOcrView } from "@/models/documents/schema"
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
  const tCommon = useTranslations("common")
  const usagesQuery = useCitationsForArk(projectId, ark)
  const ocrQuery = useDocumentOcr(projectId, ark)
  const usages = usagesQuery.data

  // The exact-folio surfaces are inlined inside `hasFolio` guards below so TS
  // narrows `folio` to a number. Folio is mandatory on a citation, but the
  // guard lets a malformed one degrade to the document-level Gallica viewer.
  const hasFolio = ark != null && folio != null
  // Document-level Gallica item page — used when the folio is missing/malformed.
  const gallicaUrl = ark ? gallicaItemUrl(ark, 1) : null

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
                src={iiifImageUrl(ark, folio, "200,")}
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
              isLoading={ocrQuery.isLoading}
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
          <div>
            <div className="mono-eyebrow mb-2.5 text-neutral-600">{t("consult")}</div>
            <div className="flex flex-col gap-2">
              {hasFolio ? (
                <CiteAction
                  href={gallicaViewerUrl(ark, folio)}
                  icon={<Eye className="size-4" strokeWidth={1.8} />}
                  title={t("iiifViewer", { folio })}
                  subtitle={t("iiifViewerSub")}
                  primary
                />
              ) : null}
              {hasFolio ? (
                <CiteAction
                  href={gallicaItemUrl(ark, folio)}
                  icon={<BookOpen className="size-4" strokeWidth={1.8} />}
                  title={t("gallicaViewer")}
                  subtitle={t("gallicaViewerSub")}
                />
              ) : gallicaUrl ? (
                <CiteAction
                  href={gallicaUrl}
                  icon={<BookOpen className="size-4" strokeWidth={1.8} />}
                  title={t("gallicaViewer")}
                  subtitle={t("gallicaViewerSub")}
                />
              ) : null}
            </div>
          </div>

          {/* Other notes citing this ARK. Found bug B4: its loading and error
              states used to be dropped — an error read as "no other note". */}
          {usagesQuery.isLoading ? (
            <>
              <Separator />
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </>
          ) : usagesQuery.isError ? (
            <>
              <Separator />
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="min-w-0 flex-1">{t("usagesLoadError")}</span>
                <Button variant="outline" size="sm" onClick={() => void usagesQuery.refetch()}>
                  {tCommon("tryAgain")}
                </Button>
              </div>
            </>
          ) : otherNotes.length > 0 ? (
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
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// The "Qualité OCR" block (feedback 2026-09-29 #7): what produced the cited
// folio's text and, for BnF ALTO, its measured quality — with the low marker
// when it is below the threshold — plus the document's "Taux OCR". A folio with
// no stored quality (not synced yet, being built, or unavailable) says so; that
// is distinct from "not low".
function SectionCitationOcr({
  ocr,
  isLoading,
  isError,
  onRetry,
  folio,
}: {
  ocr: DocumentOcrView | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  folio: number | null
}) {
  const t = useTranslations("citations.ocr")
  const tCommon = useTranslations("common")

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }
  if (isError || ocr === undefined) {
    return (
      <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
        <span className="min-w-0 flex-1">{t("loadError")}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  const view = folio === null ? undefined : ocr.folios.find((f) => f.folio === folio)
  const folioLine = (() => {
    if (view === undefined) return t("unavailable")
    if (view.ocrSource === OCR_SOURCE.MISTRAL) return t("folioMistral")
    if (view.ocrSource === OCR_SOURCE.VISION) return t("folioVision")
    if (view.ocrQuality === null || view.wordCount === null) return t("folioAltoUnscored")
    return t("folioAlto", { quality: ocrPercent(view.ocrQuality), words: view.wordCount })
  })()

  return (
    <div>
      <div className="mono-eyebrow mb-1.5 text-neutral-600">{t("sheetTitle")}</div>
      <p className="text-[12.5px] text-foreground">{folioLine}</p>
      {view?.low ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-warning">
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
          {t("lowFolio")}
        </p>
      ) : null}
      {ocr.ocrRate !== null ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {t("docRate", { rate: ocrPercent(ocr.ocrRate) })}
        </p>
      ) : null}
    </div>
  )
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
