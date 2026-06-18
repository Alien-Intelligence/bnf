"use client"

// components/sheets/corpus/document-detail.tsx
// Side panel showing full metadata for a selected corpus document.
// External BnF/IIIF deep-links + Citation panel come in slice 5.
// Client component: controls Sheet open state via prop-driven open/onOpenChange.

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import { BadgeDocumentLang } from "@/components/badges/documents/lang-badge"
import { BadgeDocumentSource } from "@/components/badges/documents/source-badge"
import type { DocumentRow } from "@/models/corpus/schema"

interface Props {
  doc: DocumentRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SheetDocumentDetail({ doc, open, onOpenChange }: Props) {
  const t = useTranslations("corpus.documents")

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen: boolean) => onOpenChange(nextOpen)}
    >
      <SheetContent side="right">
        {doc ? (
          <>
            <SheetHeader>
              <SheetTitle>{doc.title}</SheetTitle>
              {(doc.author || doc.year) && (
                <SheetDescription>
                  {[doc.author, doc.year].filter(Boolean).join(" · ")}
                </SheetDescription>
              )}
            </SheetHeader>

            <Separator />

            <div className="flex flex-col gap-4 px-4 pb-4">
              {/* Badges */}
              <div className="flex flex-wrap gap-1">
                {doc.docType && <BadgeDocumentType code={doc.docType} />}
                {doc.lang && <BadgeDocumentLang code={doc.lang} />}
                {doc.source && <BadgeDocumentSource code={doc.source} />}
              </div>

              {/* ARK — monospace, selectable */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t("arkLabel")}
                </span>
                <span className="text-xs font-mono select-all break-all">
                  {doc.ark}
                </span>
              </div>

              {/* Excerpt */}
              {doc.excerpt && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t("excerptLabel")}
                  </span>
                  <p className="text-sm leading-relaxed">{doc.excerpt}</p>
                </div>
              )}

              {/* IIIF manifest link — muted label only, no new tab logic (slice 5) */}
              {doc.iiifManifestUrl && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t("iiifLabel")}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono break-all">
                    {doc.iiifManifestUrl}
                  </span>
                </div>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
