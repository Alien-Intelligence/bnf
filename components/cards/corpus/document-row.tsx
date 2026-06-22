"use client"

// components/cards/corpus/document-row.tsx
// Clickable document row for the corpus comprehension list. Horizontal layout
// (type-colored thumb · title/meta/ARK · lang+type chips · arrow) mirroring the
// prototype rows (design/BnF Corpus Research.dc.html lines 410-421).

import { ArrowRight, Loader2, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import { BadgeDocumentLang } from "@/components/badges/documents/lang-badge"
import { BadgeDocumentThumb } from "@/components/badges/documents/thumb"
import { TYPE_DATASET_COLOR } from "@/lib/constants"
import { cn } from "@/lib/utils"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import type { DocumentRow } from "@/models/corpus/schema"

interface Props {
  doc: DocumentRow
  onClick?: () => void
}

export function CardCorpusDocumentRow({ doc, onClick }: Props) {
  const t = useTranslations("corpus.documents")

  const meta = [doc.author, doc.dateLabel ?? doc.year, doc.source]
    .filter(Boolean)
    .join(" · ")

  const isPending = doc.resolveStatus === DOCUMENT_RESOLVE_STATUS.PENDING
  const isFailed = doc.resolveStatus === DOCUMENT_RESOLVE_STATUS.FAILED
  // Stubs have no title until the background resolver fills it in.
  const titleText = doc.title ?? (isFailed ? t("resolveFailed") : t("resolving"))

  const thumbColor = doc.docType
    ? (TYPE_DATASET_COLOR[doc.docType] ?? "var(--muted)")
    : "var(--muted)"

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BadgeDocumentThumb color={thumbColor} size="sm" />

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-1.5 truncate text-[13px] font-semibold",
            doc.title ? "text-foreground" : "text-muted-foreground italic",
          )}
        >
          {isPending && (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          )}
          {isFailed && (
            <TriangleAlert className="size-3 shrink-0 text-destructive" aria-hidden />
          )}
          <span className="truncate">{titleText}</span>
        </span>
        {meta && (
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {meta}
          </span>
        )}
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground/70">
          {doc.ark}
        </span>
      </span>

      {doc.lang && <BadgeDocumentLang code={doc.lang} />}
      {doc.docType && <BadgeDocumentType code={doc.docType} />}

      <ArrowRight
        className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-brand-teal"
        aria-hidden
      />
    </button>
  )
}
