"use client"

import { useMemo } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { ArrowUpRight, BookOpen, Eye } from "lucide-react"
import { iiifImageUrl, gallicaItemUrl, gallicaViewerUrl } from "@/lib/citations/external"
import { useCitationsForArk, type CitationUsage } from "@/hooks/api/citations"
import { cn } from "@/lib/utils"
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
  const { data: usages } = useCitationsForArk(projectId, ark)

  // The exact-folio surfaces are inlined inside `hasFolio` guards below so TS
  // narrows `folio` to a number. Folio is mandatory on a citation, but the
  // guard lets a malformed one degrade to the document-level Gallica viewer.
  const hasFolio = ark != null && folio != null
  const gallicaUrl = ark ? gallicaViewerUrl(ark) : null

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
                  href={gallicaItemUrl(ark, folio)}
                  icon={<Eye className="size-4" strokeWidth={1.8} />}
                  title={t("iiifViewer", { folio })}
                  subtitle={t("iiifViewerSub")}
                  primary
                />
              ) : null}
              {gallicaUrl ? (
                <CiteAction
                  href={gallicaUrl}
                  icon={<BookOpen className="size-4" strokeWidth={1.8} />}
                  title={t("gallicaViewer")}
                  subtitle={t("gallicaViewerSub")}
                />
              ) : null}
            </div>
          </div>

          {/* Other notes citing this ARK */}
          {otherNotes.length > 0 ? (
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
