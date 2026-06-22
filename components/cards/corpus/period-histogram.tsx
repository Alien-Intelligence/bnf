"use client"

// components/cards/corpus/period-histogram.tsx
// Chronological distribution as evenly-spread clickable bars (design:
// "Répartition chronologique"). Flexbox — each decade bar is flex-1 so the bars
// fill the full width regardless of how few there are (no left-bunching).
// Keys in periodFacet look like "1880s" — each a decade bucket.

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface Props {
  /** Map of decade label → document count, e.g. { "1880s": 42, "1890s": 17 }. */
  periodFacet: Record<string, number>
  /** Number of documents with no datable year. */
  undatedCount: number
  /** Number of documents whose metadata (incl. date) is still resolving. */
  pendingCount?: number
  /** Inclusive lower bound of the active range (decade start). */
  yearFrom?: number
  /** Inclusive upper bound of the active range (decade end). */
  yearTo?: number
  /** Called with (decadeStart, decadeStart + 9) when a bar is clicked. */
  onSelectRange: (from: number, to: number) => void
  /** Called when the "undated" tile is clicked. */
  onSelectUndated: () => void
}

// Parse "1880s" → 1880. Returns NaN for malformed keys.
function parseDecadeLabel(label: string): number {
  return parseInt(label.replace(/s$/i, ""), 10)
}

// Max bar height in px; bars scale proportionally to the largest bucket.
const BAR_AREA = 80

export function CardCorpusPeriodHistogram({
  periodFacet,
  undatedCount,
  pendingCount = 0,
  yearFrom,
  yearTo,
  onSelectRange,
  onSelectUndated,
}: Props) {
  const t = useTranslations("corpus.filters")

  const decades = Object.entries(periodFacet)
    .map(([label, count]) => ({ decade: parseDecadeLabel(label), label, count }))
    .filter(({ decade }) => !isNaN(decade))
    .sort((a, b) => a.decade - b.decade)

  if (decades.length === 0 && undatedCount === 0 && pendingCount === 0) return null

  const maxCount = Math.max(...decades.map((d) => d.count), 1)

  return (
    <div className="flex items-end gap-4">
      {decades.length > 0 && (
        <div className="flex flex-1 items-end gap-2">
          {decades.map(({ decade, label, count }) => {
            const barH = Math.max(Math.round((count / maxCount) * BAR_AREA), 3)
            const isActive =
              yearFrom !== undefined &&
              yearTo !== undefined &&
              decade >= yearFrom &&
              decade <= yearTo

            return (
              <button
                key={decade}
                type="button"
                onClick={() => onSelectRange(decade, decade + 9)}
                aria-pressed={isActive}
                aria-label={t("barAriaLabel", { decade, count })}
                className="group flex flex-1 flex-col items-center justify-end gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {count.toLocaleString("fr-FR")}
                </span>
                <span
                  className={cn(
                    "w-full max-w-10 rounded-t-[3px] transition-colors",
                    isActive
                      ? "bg-brand-teal"
                      : "bg-brand-teal/45 group-hover:bg-brand-teal/70",
                  )}
                  style={{ height: barH }}
                />
                <span className="text-[9px] text-muted-foreground">{label}</span>
              </button>
            )
          })}
        </div>
      )}

      {undatedCount > 0 && (
        <button
          type="button"
          onClick={onSelectUndated}
          className="flex flex-col items-center justify-center rounded border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={t("undatedAriaLabel", { count: undatedCount })}
        >
          <span className="font-semibold tabular-nums">{undatedCount}</span>
          <span className="mt-0.5 text-[9px] leading-tight whitespace-nowrap">
            {t("undated")}
          </span>
        </button>
      )}

      {/* Pending stubs have no date yet — a non-clickable status tile (not a
          filter), shrinks to zero as the background resolver completes. */}
      {pendingCount > 0 && (
        <div
          className="flex flex-col items-center justify-center rounded border border-dashed px-2 py-1 text-xs text-muted-foreground"
          aria-label={t("pendingAriaLabel", { count: pendingCount })}
        >
          <span className="font-semibold tabular-nums">{pendingCount}</span>
          <span className="mt-0.5 text-[9px] leading-tight whitespace-nowrap">
            {t("pending")}
          </span>
        </div>
      )}
    </div>
  )
}
