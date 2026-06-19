"use client"

// components/cards/corpus/filters-drawer.tsx
// Interactive Collapsible filter drawer (slice-2).
// Replaces the read-only facet-row version with chip groups + histogram.
// Collapsed by default per UX contract (design/docs/01).

import { useState, useCallback, useMemo } from "react"
import { ChevronDown, SlidersHorizontal } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { DOC_TYPE, LANG, SOURCE } from "@/models/documents/schema"
import { DATASET_COLOR_CYCLE, TYPE_DATASET_COLOR } from "@/lib/constants"
import { cn } from "@/lib/utils"
import type { CorpusSnapshot } from "@/models/corpus/schema"
import type { CorpusFilters } from "@/models/corpus/types"
import { emptyCorpusFilters } from "@/models/corpus/types"
import { CardCorpusFacetBars } from "./facet-bars"
import { CardCorpusPeriodHistogram } from "./period-histogram"
import { CardCorpusFullTextInput } from "./full-text-input"
import { CardCorpusActiveFiltersBar } from "./active-filters-bar"
import { CardCorpusNumerisationCard } from "./numerisation-card"

// One bordered facet card in the 3-column statistics grid.
function FacetCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="mb-3 text-xs font-semibold text-foreground">{title}</div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

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
function langLabel(code: string): string {
  return LANG[code]?.label ?? code
}
function sourceLabel(code: string): string {
  return SOURCE[code]?.label ?? code
}

// Facet bar colors are dataset hues (dark-first), not the pastel badge classes.
// Type follows the prototype's fixed mapping; lang highlights the dominant
// language in brand teal; source uses a single dataset hue. See
// design/BnF Corpus Research.dc.html renderVals (lines ~1788-1800).
function typeColorVar(code: string, index: number): string {
  return TYPE_DATASET_COLOR[code] ?? DATASET_COLOR_CYCLE[index % DATASET_COLOR_CYCLE.length]
}
function langColorVar(_code: string, index: number): string {
  return index === 0 ? "var(--brand-teal)" : "var(--neutral-500)"
}
function sourceColorVar(): string {
  return "var(--dataset-5)"
}

// ---------------------------------------------------------------------------
// Non-clickable status row (resolution buckets). Visually matches a facet bar
// minus the bar/interaction — pending/failed are statuses, not filterable
// dimensions, so they must not route through onToggle.
// ---------------------------------------------------------------------------

function FacetStatusRow({
  label,
  count,
  color,
}: {
  label: string
  count: number
  color: string
}) {
  return (
    <div className="flex items-center gap-2 p-1">
      <span
        className="size-2.5 shrink-0 rounded-[2px] opacity-70"
        style={{ background: color }}
        aria-hidden
      />
      <span className="flex-1 truncate text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {count.toLocaleString("fr-FR")}
      </span>
    </div>
  )
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

  const { facets, pendingCount, failedCount } = corpus

  const typeSelected = csvToSelected(filters.type)
  const langSelected = csvToSelected(filters.lang)
  const sourceSelected = csvToSelected(filters.source)
  const ingestSelected = csvToSelected(filters.ingest)

  // Count of active filter dimensions, for the trigger badge.
  const activeCount =
    typeSelected.length +
    langSelected.length +
    sourceSelected.length +
    ingestSelected.length +
    (filters.yearFrom !== undefined || filters.yearTo !== undefined ? 1 : 0) +
    (filters.undated ? 1 : 0) +
    (filters.q && filters.q.trim().length > 0 ? 1 : 0)

  const hasAnyFacets =
    Object.keys(facets.type).length > 0 ||
    Object.keys(facets.lang).length > 0 ||
    Object.keys(facets.source).length > 0 ||
    Object.keys(facets.period).length > 0 ||
    pendingCount > 0 ||
    failedCount > 0

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
  const handleIngestToggle = useCallback(
    (code: string) =>
      onChange({ ...filters, ingest: toggleInCsv(filters.ingest, code) }),
    [filters, onChange],
  )
  const handleRangeSelect = useCallback(
    (from: number, to: number) => {
      // Toggle: re-clicking the already-active range clears the year filter,
      // mirroring the facet bars' click-to-unset behaviour.
      const isActiveRange =
        filters.yearFrom === from && filters.yearTo === to
      onChange({
        ...filters,
        yearFrom: isActiveRange ? undefined : from,
        yearTo: isActiveRange ? undefined : to,
        undated: undefined,
      })
    },
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
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-md border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40">
        <span className="flex min-w-0 items-center gap-2.5">
          <SlidersHorizontal className="size-3.5 shrink-0 text-brand-teal" />
          <span className="text-[13px] font-semibold text-foreground">
            {t("title")}
          </span>
          <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
            {t("hint")}
          </span>
          {activeCount > 0 && (
            <span className="shrink-0 rounded-full border border-brand-teal/30 bg-brand-teal/10 px-2 py-px font-mono text-[10px] text-brand-teal">
              {t("activeBadge", { count: activeCount })}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="rounded-md border border-t-0 bg-card px-4 py-4">
        <div className="flex flex-col gap-3.5">
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

          {/* Facet cards: type / lang / source side-by-side */}
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
            {(Object.keys(facets.type).length > 0 ||
              pendingCount > 0 ||
              failedCount > 0) && (
              <FacetCard title={t("facetTypeTitle")}>
                {Object.keys(facets.type).length > 0 && (
                  <CardCorpusFacetBars
                    facet={facets.type}
                    selected={typeSelected}
                    onToggle={handleTypeToggle}
                    getLabel={typeLabel}
                    getColor={typeColorVar}
                    swatchShape="square"
                  />
                )}
                {/* Non-clickable status rows: pending shrinks to zero as the
                    background resolver completes; failed surfaces dead ARKs. */}
                {pendingCount > 0 && (
                  <FacetStatusRow
                    label={t("pending")}
                    count={pendingCount}
                    color="var(--neutral-500)"
                  />
                )}
                {failedCount > 0 && (
                  <FacetStatusRow
                    label={t("failed")}
                    count={failedCount}
                    color="var(--destructive)"
                  />
                )}
              </FacetCard>
            )}

            {Object.keys(facets.lang).length > 0 && (
              <FacetCard title={t("facetLangTitle")}>
                <CardCorpusFacetBars
                  facet={facets.lang}
                  selected={langSelected}
                  onToggle={handleLangToggle}
                  getLabel={langLabel}
                  getColor={langColorVar}
                  swatchShape="dot"
                />
              </FacetCard>
            )}

            {Object.keys(facets.source).length > 0 && (
              <FacetCard title={t("facetSourceTitle")}>
                <CardCorpusFacetBars
                  facet={facets.source}
                  selected={sourceSelected}
                  onToggle={handleSourceToggle}
                  getLabel={sourceLabel}
                  getColor={sourceColorVar}
                  swatchShape="square"
                />
              </FacetCard>
            )}
          </div>

          {/* Chronological distribution card */}
          {(Object.keys(facets.period).length > 0 ||
            corpus.undatedCount > 0 ||
            pendingCount > 0) && (
            <div className="rounded-md border bg-background p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {t("chrono.title")}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {t("chrono.hint")}
                </span>
              </div>
              <CardCorpusPeriodHistogram
                periodFacet={facets.period}
                undatedCount={corpus.undatedCount}
                pendingCount={pendingCount}
                yearFrom={filters.yearFrom}
                yearTo={filters.yearTo}
                onSelectRange={handleRangeSelect}
                onSelectUndated={handleUndatedSelect}
              />
            </div>
          )}

          {/* Numérisation & océrisation card (clickable ingestion-class filters) */}
          {corpus.numerisation.resolved > 0 && (
            <CardCorpusNumerisationCard
              numerisation={corpus.numerisation}
              selected={ingestSelected}
              onToggle={handleIngestToggle}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
