"use client"

// components/cards/corpus/period-histogram.tsx
// Custom SVG period histogram for corpus chronological distribution.
// Keys in periodFacet look like "1880s" — each is a decade bucket.
// No external chart library. Roughly 80 lines of logic.

import { useTranslations } from "next-intl"

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

const SVG_HEIGHT = 60
const BAR_WIDTH = 20
const BAR_GAP = 4
const LABEL_HEIGHT = 14

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

  const totalWidth =
    decades.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP

  return (
    <div className="flex items-end gap-4">
      {decades.length > 0 && (
        <svg
          width={totalWidth}
          height={SVG_HEIGHT + LABEL_HEIGHT}
          aria-label={t("histogramAriaLabel")}
          role="img"
          className="overflow-visible"
        >
          <title>{t("histogramAriaLabel")}</title>
          {decades.map(({ decade, label, count }, i) => {
            const barH = Math.max(
              Math.round((count / maxCount) * SVG_HEIGHT),
              2,
            )
            const x = i * (BAR_WIDTH + BAR_GAP)
            const y = SVG_HEIGHT - barH

            const isActive =
              yearFrom !== undefined &&
              yearTo !== undefined &&
              decade >= yearFrom &&
              decade <= yearTo

            return (
              <g
                key={decade}
                onClick={() => onSelectRange(decade, decade + 9)}
                className="cursor-pointer group"
                role="button"
                tabIndex={0}
                aria-label={t("barAriaLabel", { decade, count })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onSelectRange(decade, decade + 9)
                  }
                }}
              >
                <title>
                  {t("barAriaLabel", { decade, count })}
                </title>
                <rect
                  x={x}
                  y={y}
                  width={BAR_WIDTH}
                  height={barH}
                  rx={2}
                  className={
                    isActive
                      ? "fill-brand-teal"
                      : "fill-brand-teal/45 group-hover:fill-brand-teal/70 transition-colors"
                  }
                />
                {/* decade label below bar */}
                <text
                  x={x + BAR_WIDTH / 2}
                  y={SVG_HEIGHT + LABEL_HEIGHT - 2}
                  textAnchor="middle"
                  className="text-[9px] fill-muted-foreground select-none"
                  style={{ fontSize: 9 }}
                >
                  {label}
                </text>
              </g>
            )
          })}
        </svg>
      )}

      {undatedCount > 0 && (
        <button
          type="button"
          onClick={onSelectUndated}
          className="flex flex-col items-center justify-center rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("undatedAriaLabel", { count: undatedCount })}
        >
          <span className="font-semibold tabular-nums">{undatedCount}</span>
          <span className="mt-0.5 text-[9px] leading-tight text-center whitespace-nowrap">
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
          <span className="mt-0.5 text-[9px] leading-tight text-center whitespace-nowrap">
            {t("pending")}
          </span>
        </div>
      )}
    </div>
  )
}
