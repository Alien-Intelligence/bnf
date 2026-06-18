"use client"

// components/cards/corpus/filters-drawer.tsx
// Collapsible filter/statistics drawer — collapsed by default.
// Client component: Collapsible open state requires useState.

import { useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import { BadgeDocumentLang } from "@/components/badges/documents/lang-badge"
import { BadgeDocumentSource } from "@/components/badges/documents/source-badge"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  corpus: CorpusSnapshot
}

interface FacetSectionProps {
  title: string
  entries: Array<{ code: string; count: number }>
  renderBadge: (code: string) => React.ReactNode
}

function FacetSection({ title, entries, renderBadge }: FacetSectionProps) {
  if (entries.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </span>
      <ul className="flex flex-col gap-1">
        {entries.map(({ code, count }) => (
          <li key={code} className="flex items-center justify-between gap-2">
            {renderBadge(code)}
            <span className="text-xs text-muted-foreground tabular-nums">
              {count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function facetEntries(
  facet: Record<string, number>,
): Array<{ code: string; count: number }> {
  return Object.entries(facet)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => ({ code, count }))
}

export function CardCorpusFiltersDrawer({ corpus }: Props) {
  const t = useTranslations("corpus.filters")
  const [open, setOpen] = useState(false)

  const typeEntries = facetEntries(corpus.facets.type)
  const langEntries = facetEntries(corpus.facets.lang)
  const sourceEntries = facetEntries(corpus.facets.source)
  const periodEntries = facetEntries(corpus.facets.period)

  const allEmpty =
    typeEntries.length === 0 &&
    langEntries.length === 0 &&
    sourceEntries.length === 0 &&
    periodEntries.length === 0

  // Empty branch — header only with a small explanatory note.
  if (allEmpty) {
    return (
      <div className="flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-sm font-medium">
        <span>{t("title")}</span>
        <span className="text-xs text-muted-foreground">{t("empty")}</span>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors">
        <span>{t("title")}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="rounded-md border border-t-0 bg-card px-4 py-4">
        <div className="flex flex-col gap-4">
          <FacetSection
            title={t("byType")}
            entries={typeEntries}
            renderBadge={(code) => <BadgeDocumentType code={code} />}
          />

          {typeEntries.length > 0 && langEntries.length > 0 && (
            <Separator />
          )}

          <FacetSection
            title={t("byLang")}
            entries={langEntries}
            renderBadge={(code) => <BadgeDocumentLang code={code} />}
          />

          {langEntries.length > 0 && sourceEntries.length > 0 && (
            <Separator />
          )}

          <FacetSection
            title={t("bySource")}
            entries={sourceEntries}
            renderBadge={(code) => <BadgeDocumentSource code={code} />}
          />

          {sourceEntries.length > 0 && periodEntries.length > 0 && (
            <Separator />
          )}

          <FacetSection
            title={t("byPeriod")}
            entries={periodEntries}
            renderBadge={(code) => (
              <span className="text-sm font-mono">{code}</span>
            )}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
