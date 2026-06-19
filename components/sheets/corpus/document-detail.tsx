"use client"

// components/sheets/corpus/document-detail.tsx
// Side panel showing full metadata for a selected corpus document, mirroring
// the prototype "Notice · BnF" panel (design/BnF Corpus Research.dc.html lines
// 430-487): type-tinted thumb + title/author, a 2-col metadata grid (incl. the
// numérisation/océrisation/ingestion fields), the OCR excerpt, the ARK box, the
// "Consulter sur la BnF" deep-links (IIIF viewer / Gallica / manifest / OAI for
// digitized docs; catalogue record for cb… notices), and a "Retirer" action.
//
// Client component: drives Sheet open state, derives external links, and owns
// the remove mutation.

import { useTranslations } from "next-intl"
import { Braces, Code2, Eye, FileText, ExternalLink, Trash2 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import {
  CATALOGUE_RECORD_URL,
  GALLICA_DOCUMENT_URL,
  GALLICA_IIIF_VIEWER_URL,
  GALLICA_OAI_URL,
  IIIF_MANIFEST_URL,
  TYPE_DATASET_COLOR,
} from "@/lib/constants"
import { useRemoveFromCorpus } from "@/hooks/api/corpus"
import {
  DOC_TYPE,
  INGESTION_CLASS,
  LANG,
  SOURCE,
  classifyIngestion,
} from "@/models/documents/schema"
import type { DocumentRow } from "@/models/corpus/schema"

interface Props {
  doc: DocumentRow | null
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// One label/value pair in the metadata grid.
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono-eyebrow">{label}</span>
      <span className="text-[12.5px] text-foreground">{value}</span>
    </div>
  )
}

// One "Consulter sur la BnF" deep-link card.
function LinkCard({
  href,
  icon,
  title,
  subtitle,
  accent = false,
}: {
  href: string
  icon: React.ReactNode
  title: string
  subtitle: string
  accent?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        accent
          ? "flex items-center gap-3 rounded-md border border-brand-teal/35 bg-brand-teal/10 px-3 py-2.5 transition-colors hover:bg-brand-teal/15"
          : "flex items-center gap-3 rounded-md border bg-transparent px-3 py-2.5 transition-colors hover:border-muted-foreground/60"
      }
    >
      <span className={accent ? "text-brand-teal" : "text-muted-foreground"}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-foreground">
          {title}
        </span>
        <span className="block text-[10.5px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  )
}

export function SheetDocumentDetail({ doc, projectId, open, onOpenChange }: Props) {
  const t = useTranslations("corpus.documents")
  const remove = useRemoveFromCorpus(projectId)

  if (!doc) {
    // Keep the Sheet mounted (with an a11y title) so open/close transitions run.
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="mono-eyebrow font-mono text-[10px]">
              {t("detail.eyebrow")}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t("detail.eyebrow")}
            </SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )
  }

  const digitized = Boolean(doc.iiifManifestUrl)
  const cls = classifyIngestion({
    docType: doc.docType,
    ocrAvailable: doc.ocrAvailable,
    digitized,
  })

  const typeLabel = doc.docType
    ? (DOC_TYPE[doc.docType]?.label ?? doc.docType)
    : t("detail.values.unknown")
  const langLabel = doc.lang ? (LANG[doc.lang]?.label ?? doc.lang) : "—"
  const sourceLabel = doc.source
    ? (SOURCE[doc.source]?.label ?? doc.source)
    : "—"
  const dateLabel = doc.dateLabel ?? (doc.year != null ? String(doc.year) : "—")

  const ocrLabel = (() => {
    if (doc.ocrAvailable === true) return t("detail.values.ocrAvailable")
    if (cls === INGESTION_CLASS.VISION) return t("detail.values.noOcrImage")
    return t("detail.values.noOcr")
  })()

  const ingestionLabel = {
    [INGESTION_CLASS.OCR]: t("detail.values.ingestOcr"),
    [INGESTION_CLASS.VISION]: t("detail.values.ingestVision"),
    [INGESTION_CLASS.SANS_TEXTE]: t("detail.values.ingestSansTexte"),
    [INGESTION_CLASS.NON_NUMERISE]: t("detail.values.ingestNonNumerise"),
  }[cls]

  // Document-level external links. Gallica/IIIF/OAI links only resolve for a
  // digitized Gallica document (bpt6k…/btv1b…). A non-digitized catalogue
  // notice (cb…) links to its BnF catalogue record instead.
  const manifestUrl = doc.iiifManifestUrl ?? IIIF_MANIFEST_URL(doc.ark)

  const thumbColor = doc.docType
    ? (TYPE_DATASET_COLOR[doc.docType] ?? "var(--muted)")
    : "var(--muted)"

  function onRemove() {
    if (!doc) return
    remove.mutate(
      { arks: [doc.ark], reason: "Retiré du corpus depuis le panneau de notice" },
      { onSuccess: () => onOpenChange(false) },
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2 font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase">
            <FileText className="size-3.5" />
            {t("detail.eyebrow")}
          </SheetTitle>
          <SheetDescription className="sr-only">{doc.title ?? doc.ark}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6">
          {/* Header: thumb + type chip + title + author */}
          <div className="flex items-start gap-3.5">
            <span
              className="size-14 shrink-0 rounded-md"
              style={{ background: `color-mix(in srgb, ${thumbColor} 22%, var(--card))` }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              {doc.docType && <BadgeDocumentType code={doc.docType} />}
              <h2 className="mt-2 text-[15px] leading-snug font-semibold tracking-tight">
                {doc.title ?? doc.ark}
              </h2>
              {doc.author && (
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {doc.author}
                </p>
              )}
            </div>
          </div>

          {/* Metadata grid */}
          <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-3.5">
            <Field label={t("detail.fields.type")} value={typeLabel} />
            <Field label={t("detail.fields.date")} value={dateLabel} />
            <Field
              label={t("detail.fields.pages")}
              value={doc.pages != null ? String(doc.pages) : "—"}
            />
            <Field label={t("detail.fields.lang")} value={langLabel} />
            <Field label={t("detail.fields.deposit")} value={sourceLabel} />
            <Field
              label={t("detail.fields.digitization")}
              value={
                digitized
                  ? t("detail.values.digitized")
                  : t("detail.values.notDigitized")
              }
            />
            <Field label={t("detail.fields.ocr")} value={ocrLabel} />
            <Field label={t("detail.fields.ingestion")} value={ingestionLabel} />
          </div>

          {/* OCR excerpt */}
          {doc.excerpt && (
            <div className="mt-5">
              <span className="mono-eyebrow">{t("detail.excerptOcr")}</span>
              <p className="mt-2 border-l-2 pl-3.5 text-[13px] leading-relaxed whitespace-pre-line text-muted-foreground">
                {doc.excerpt}
              </p>
            </div>
          )}

          {/* ARK box */}
          <div className="mt-5 rounded-md border bg-input/20 px-3 py-2.5">
            <span className="mono-eyebrow">{t("detail.arkIdentifier")}</span>
            <p className="mt-1 font-mono text-[11.5px] break-all text-brand-teal select-all">
              {doc.ark}
            </p>
          </div>

          {/* External links */}
          <div className="mt-5">
            <span className="mono-eyebrow">{t("detail.consultBnf")}</span>
            <div className="mt-2.5 flex flex-col gap-2">
              {digitized ? (
                <>
                  <LinkCard
                    href={GALLICA_IIIF_VIEWER_URL(doc.ark)}
                    accent
                    icon={<Eye className="size-4" />}
                    title={t("detail.iiifViewer")}
                    subtitle={t("detail.iiifViewerSub")}
                  />
                  <LinkCard
                    href={GALLICA_DOCUMENT_URL(doc.ark)}
                    icon={<FileText className="size-4" />}
                    title={t("detail.gallicaNotice")}
                    subtitle={t("detail.gallicaNoticeSub")}
                  />
                  <LinkCard
                    href={manifestUrl}
                    icon={<Braces className="size-4" />}
                    title={t("detail.iiifManifest")}
                    subtitle={t("detail.iiifManifestSub")}
                  />
                  <LinkCard
                    href={GALLICA_OAI_URL(doc.ark)}
                    icon={<Code2 className="size-4" />}
                    title={t("detail.oai")}
                    subtitle={t("detail.oaiSub")}
                  />
                </>
              ) : (
                <LinkCard
                  href={CATALOGUE_RECORD_URL(doc.ark)}
                  icon={<FileText className="size-4" />}
                  title={t("detail.catalogueRecord")}
                  subtitle={t("detail.catalogueRecordSub")}
                />
              )}
            </div>
          </div>

          {/* Remove from corpus */}
          <Button
            variant="outline"
            className="mt-5 w-full text-destructive hover:text-destructive"
            onClick={onRemove}
            disabled={remove.isPending}
          >
            <Trash2 className="size-3.5" />
            {remove.isPending ? t("detail.removing") : t("detail.remove")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
