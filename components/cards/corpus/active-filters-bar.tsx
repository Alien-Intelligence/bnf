"use client"

// components/cards/corpus/active-filters-bar.tsx
// Row of dismissible chips showing every active filter value.
// Returns null when no filter is set (hasActiveFilters === false).

import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  EMPTY_CORPUS_FILTERS,
  hasActiveFilters,
  patchFilters,
  removeFilterValue,
  selectedValues,
} from "@/lib/corpus/filter-state"
import type { CorpusFilterSet } from "@/models/corpus/types"
import {
  INDEXATION_OUTCOME,
  INGESTION_CLASS,
} from "@/models/documents/schema"

// Chip label keys, keyed off the domain enums rather than re-typed string
// literals: a renamed outcome or ingestion class is then a type error here
// instead of a chip that silently falls back to showing the raw code.
const INGEST_LABEL_KEY: Record<string, string> = {
  [INGESTION_CLASS.OCR]: "numerisation.ocr",
  [INGESTION_CLASS.VISION]: "numerisation.vision",
  [INGESTION_CLASS.SANS_TEXTE]: "numerisation.sansTexte",
  [INGESTION_CLASS.NON_NUMERISE]: "numerisation.nonNumerise",
}

const OUTCOME_LABEL_KEY: Record<string, string> = {
  [INDEXATION_OUTCOME.INDEXED]: "indexation.indexed",
  [INDEXATION_OUTCOME.FAILED]: "indexation.failed",
  [INDEXATION_OUTCOME.EXCLUDED]: "indexation.excluded",
  [INDEXATION_OUTCOME.NOT_INGESTED]: "indexation.notIngested",
}

interface Props {
  filters: CorpusFilterSet
  onChange: (next: CorpusFilterSet) => void
  onClearAll: () => void
  /**
   * Maps an AppSession id to its human title, for the session chip label.
   * Sessions live only on the snapshot (not in vocab), so the drawer threads
   * this through. Missing ids fall back to the raw id.
   */
  sessionTitleById?: Record<string, string>
}

interface ChipProps {
  label: string
  onRemove: () => void
}

function ActiveChip({ label, onRemove }: ChipProps) {
  // Scoped here rather than threaded from the parent: the remove button's
  // accessible name is a user-visible string like any other, and a screen-reader
  // user in the English locale was hearing French.
  const t = useTranslations("corpus.filters")
  return (
    <Badge variant="secondary" className="flex items-center gap-1 font-normal">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={t("active.remove", { label })}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

export function CardCorpusActiveFiltersBar({
  filters,
  onChange,
  onClearAll,
  sessionTitleById,
}: Props) {
  const t = useTranslations("corpus.filters")

  if (!hasActiveFilters(filters)) return null

  const chips: React.ReactNode[] = []

  // Multi-select: type, lang, source
  const multiKeys = ["type", "lang", "source"] as const
  for (const key of multiKeys) {
    for (const value of selectedValues(filters, key)) {
      chips.push(
        <ActiveChip
          key={`${key}:${value}`}
          label={value}
          onRemove={() => onChange(removeFilterValue(filters, key, value))}
        />,
      )
    }
  }

  // Sessions — label with the session title (resolved from the snapshot via the
  // threaded title map); fall back to the raw id when unknown.
  for (const value of selectedValues(filters, "session")) {
    chips.push(
      <ActiveChip
        key={`session:${value}`}
        label={sessionTitleById?.[value] ?? value}
        onRemove={() => onChange(removeFilterValue(filters, "session", value))}
      />,
    )
  }

  // Ingestion classes — readable labels from the numérisation vocabulary.
  for (const value of selectedValues(filters, "ingest")) {
    const key = INGEST_LABEL_KEY[value]
    chips.push(
      <ActiveChip
        key={`ingest:${value}`}
        label={key ? t(key) : value}
        onRemove={() => onChange(removeFilterValue(filters, "ingest", value))}
      />,
    )
  }

  // Indexation outcomes — readable labels from the indexation vocabulary.
  for (const value of selectedValues(filters, "outcome")) {
    const key = OUTCOME_LABEL_KEY[value]
    chips.push(
      <ActiveChip
        key={`outcome:${value}`}
        label={key ? t(key) : value}
        onRemove={() => onChange(removeFilterValue(filters, "outcome", value))}
      />,
    )
  }

  // Year range
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    const from = filters.yearFrom
    const to = filters.yearTo
    const label =
      from !== undefined && to !== undefined
        ? `${from}–${to}`
        : from !== undefined
          ? `≥ ${from}`
          : `≤ ${to}`
    chips.push(
      <ActiveChip
        key="yearRange"
        label={label}
        onRemove={() =>
          onChange(patchFilters(filters, { yearFrom: undefined, yearTo: undefined }))
        }
      />,
    )
  }

  // Undated
  if (filters.undated) {
    chips.push(
      <ActiveChip
        key="undated"
        label={t("undated")}
        onRemove={() => onChange(patchFilters(filters, { undated: undefined }))}
      />,
    )
  }

  // Free-text query
  if (filters.q) {
    chips.push(
      <ActiveChip
        key="q"
        label={`"${filters.q}"`}
        onRemove={() => onChange(patchFilters(filters, { q: undefined }))}
      />,
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => {
          onChange(EMPTY_CORPUS_FILTERS)
          onClearAll()
        }}
      >
        {t("active.clearAll")}
      </Button>
    </div>
  )
}
