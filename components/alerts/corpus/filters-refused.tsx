"use client"

// components/alerts/corpus/filters-refused.tsx
// Shown when the page URL carried corpus filters the one filter schema refuses
// (`?undated=yes`, `?yearFrom=abc`, an unknown parameter): the page opens
// unfiltered and says why, instead of crashing the render on a thrown parse.

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  /** The refusal, as the codec or the schema worded it. */
  reason: string
}

export function AlertCorpusFiltersRefused({ reason }: Props) {
  const t = useTranslations("corpus.filters")
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      <span>{t("urlRefused", { reason })}</span>
    </div>
  )
}
