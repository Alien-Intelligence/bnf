"use client"

// components/cards/corpus/document-row.tsx
// Clickable document row for the corpus comprehension list.
// Client component: onClick callback.

import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import { BadgeDocumentLang } from "@/components/badges/documents/lang-badge"
import { BadgeDocumentSource } from "@/components/badges/documents/source-badge"
import type { DocumentRow } from "@/models/corpus/schema"

interface Props {
  doc: DocumentRow
  onClick?: () => void
}

export function CardCorpusDocumentRow({ doc, onClick }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick?.()
        }
      }}
      className="flex flex-col gap-2 rounded-md border bg-card px-4 py-3 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Title */}
      <p className="text-sm font-medium leading-snug truncate">{doc.title}</p>

      {/* Author + year */}
      <p className="text-xs text-muted-foreground truncate">
        {[doc.author, doc.year].filter(Boolean).join(" · ")}
      </p>

      {/* Badges */}
      <div className="flex flex-wrap gap-1">
        {doc.docType && <BadgeDocumentType code={doc.docType} />}
        {doc.lang && <BadgeDocumentLang code={doc.lang} />}
        {doc.source && <BadgeDocumentSource code={doc.source} />}
      </div>

      {/* Excerpt */}
      {doc.excerpt && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {doc.excerpt}
        </p>
      )}
    </div>
  )
}
