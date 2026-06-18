"use client"

// components/cards/corpus/filters-drawer.tsx
// Interactive Collapsible filter drawer (slice-2).
// Replaces the read-only facet-row version with chip groups + histogram.
// Collapsed by default per UX contract (design/docs/01).

import { useState, useCallback, useMemo } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { DOC_TYPE, LANG, SOURCE } from "@/models/documents/schema"
import type { CorpusSnapshot } from "@/models/corpus/schema"
import type { CorpusFilters } from "@/models/corpus/types"
import { emptyCorpusFilters } from "@/models/corpus/types"
import { CardCorpusFacetChips } from "./facet-chips"
import { CardCorpusPeriodHistogram } from "./period-histogram"
import { CardCorpusFullTextInput } from "./full-text-input"
import { CardCorpusActiveFiltersBar } from "./active-filters-bar"

interface Props {
  corpus: CorpusSnapshot
  /** Active filter state. Defaults to empty (no filters) when omitted. */
  filters?: CorpusFilters
  /** Called when the user changes a filter. No-op when omitted. */
  onChange?: (next: CorpusFilters) => void
}

// ---------------------------------------------------------------------------
// Helpers: split CSV into selected array; toggle a value; re-join.
// ---------------------------------------------------------------------------

function csvToSelected(csv: string | undefined): string[] {
  if (!csv) return []
  return csv.split(",").filter(Boolean)
}

function toggleInCsv(csv: string | undefined, value: string): string | undefined {
  const current = csvToSelected(csv)
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  return next.length > 0 ? next.join(",") : undefined
}

// ---------------------------------------------------------------------------
// Vocab label/color resolvers (fall back to raw code for unknown entries).
// ---------------------------------------------------------------------------

function typeLabel(code: string): string {
  return DOC_TYPE[code]?.label ?? code
}
function typeColor(code: string): string {
  return DOC_TYPE[code]?.color ?? "bg-muted text-muted-foreground"
}
function langLabel(code: string): string {
  return LANG[code]?.label ?? code
}
function langColor(code: string): string {
  return LANG[code]?.color ?? "bg-muted text-muted-foreground"
}
function sourceLabel(code: string): string {
  return SOURCE[code]?.label ?? code
}
function sourceColor(code: string): string {
  return SOURCE[code]?.color ?? "bg-muted text-muted-foreground"
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CardCorpusFiltersDrawer({
  corpus,
  filters: filtersProp,
  onChange: onChangeProp,
}: Props) {
  const t = useTranslations("corpus.filters")
  const [open, setOpen] = useState(false)

  // Provide stable defaults so the drawer is usable read-only when commit #9
  // hasn't yet wired in the filter state from the Constituer client.
  const filters: CorpusFilters = useMemo(
    () => filtersProp ?? emptyCorpusFilters(),
    [filtersProp],
  )
  // Stable no-op so useCallback deps remain stable when onChange is omitted.
  const noop = useCallback(() => undefined, [])
  const onChange: (next: CorpusFilters) => void = onChangeProp ?? noop

  const { facets } = corpus

  const typeSelected = csvToSelected(filters.type)
  const langSelected = csvToSelected(filters.lang)
  const sourceSelected = csvToSelected(filters.source)

  const hasAnyFacets =
    Object.keys(facets.type).length > 0 ||
    Object.keys(facets.lang).length > 0 ||
    Object.keys(facets.source).length > 0 ||
    Object.keys(facets.period).length > 0

  const handleTypeToggle = useCallback(
    (code: string) =>
      onChange({ ...filters, type: toggleInCsv(filters.type, code) }),
    [filters, onChange],
  )
  const handleLangToggle = useCallback(
    (code: string) =>
      onChange({ ...filters, lang: toggleInCsv(filters.lang, code) }),
    [filters, onChange],
  )
  const handleSourceToggle = useCallback(
    (code: string) =>
      onChange({ ...filters, source: toggleInCsv(filters.source, code) }),
    [filters, onChange],
  )
  const handleRangeSelect = useCallback(
    (from: number, to: number) =>
      onChange({ ...filters, yearFrom: from, yearTo: to, undated: undefined }),
    [filters, onChange],
  )
  const handleUndatedSelect = useCallback(
    () =>
      onChange({
        ...filters,
        undated: !filters.undated,
        yearFrom: undefined,
        yearTo: undefined,
      }),
    [filters, onChange],
  )
  const handleQueryCommit = useCallback(
    (q: string | undefined) => onChange({ ...filters, q }),
    [filters, onChange],
  )
  const handleClearAll = useCallback(
    () => onChange(emptyCorpusFilters()),
    [onChange],
  )

  if (!hasAnyFacets) {
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
          {/* Free-text search */}
          <CardCorpusFullTextInput
            value={filters.q}
            onCommit={handleQueryCommit}
          />

          {/* Active filters summary (dismissible chips) */}
          <CardCorpusActiveFiltersBar
            filters={filters}
            onChange={onChange}
            onClearAll={handleClearAll}
          />

          {/* Type facet */}
          {Object.keys(facets.type).length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("byType")}
                </span>
                <CardCorpusFacetChips
                  facet={facets.type}
                  selected={typeSelected}
                  onToggle={handleTypeToggle}
                  getLabel={typeLabel}
                  getColor={typeColor}
                />
              </div>
              <Separator />
            </>
          )}

          {/* Lang facet */}
          {Object.keys(facets.lang).length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("byLang")}
                </span>
                <CardCorpusFacetChips
                  facet={facets.lang}
                  selected={langSelected}
                  onToggle={handleLangToggle}
                  getLabel={langLabel}
                  getColor={langColor}
                />
              </div>
              <Separator />
            </>
          )}

          {/* Source facet */}
          {Object.keys(facets.source).length > 0 && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("bySource")}
                </span>
                <CardCorpusFacetChips
                  facet={facets.source}
                  selected={sourceSelected}
                  onToggle={handleSourceToggle}
                  getLabel={sourceLabel}
                  getColor={sourceColor}
                />
              </div>
              <Separator />
            </>
          )}

          {/* Period histogram */}
          {Object.keys(facets.period).length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t("byPeriod")}
              </span>
              <CardCorpusPeriodHistogram
                periodFacet={facets.period}
                undatedCount={
                  // undatedCount will be added to CorpusSnapshot in the schema
                  // migration commit; fall back to 0 until then.
                  (corpus as CorpusSnapshot & { undatedCount?: number })
                    .undatedCount ?? 0
                }
                yearFrom={filters.yearFrom}
                yearTo={filters.yearTo}
                onSelectRange={handleRangeSelect}
                onSelectUndated={handleUndatedSelect}
              />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
