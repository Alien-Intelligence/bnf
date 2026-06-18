"use client"

// components/cards/corpus/empty.tsx
// Empty state for the corpus document list (fresh project, no documents yet).
// Client component: rendered inside LayoutCorpusDocumentList (client boundary);
// useTranslations is used here for client-side translation.

import { BookOpen } from "lucide-react"
import { useTranslations } from "next-intl"

export function CardCorpusEmpty() {
  const t = useTranslations("corpus.documents")

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
      <BookOpen className="h-8 w-8" />
      <p className="text-sm text-center">{t("empty")}</p>
      <p className="text-xs text-center">{t("askAgentHint")}</p>
    </div>
  )
}
