"use client"

// components/cards/corpus/no-results.tsx
// Distinct empty state for "this filter combination matches zero documents".
// Differs from CardCorpusEmpty (fresh project) — here data exists, filters
// are just too narrow.

import { SearchX } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

interface Props {
  /** Called when the user clicks "Effacer les filtres". */
  onClearFilters: () => void
}

export function CardCorpusNoResults({ onClearFilters }: Props) {
  const t = useTranslations("corpus.documents")

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
      <SearchX className="h-8 w-8" />
      <p className="text-sm text-center">{t("noResults")}</p>
      <Button variant="outline" size="sm" onClick={onClearFilters}>
        {t("clearFilters")}
      </Button>
    </div>
  )
}
