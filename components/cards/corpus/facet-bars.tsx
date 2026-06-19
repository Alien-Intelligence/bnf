"use client"

// components/cards/corpus/facet-bars.tsx
// CardCorpusFacetBars — a facet distribution as clickable bars: a colored
// swatch, the label, the count, and a proportional bar. Clicking a row toggles
// that value in the active filters. Mirrors the prototype facet rows
// (design/BnF Corpus Research.dc.html renderVals, lines ~1788-1800).
//
// Colors are data-driven (per type/lang/source), so the swatch/bar color and
// the bar width are inline styles — they cannot be static Tailwind classes.

import { cn } from "@/lib/utils"

interface Props {
  facet: Record<string, number>
  selected: string[]
  onToggle: (code: string) => void
  getLabel: (code: string) => string
  /** CSS color for a row's swatch + bar, e.g. "var(--dataset-3)". */
  getColor: (code: string, index: number) => string
  swatchShape?: "dot" | "square"
}

export function CardCorpusFacetBars({
  facet,
  selected,
  onToggle,
  getLabel,
  getColor,
  swatchShape = "dot",
}: Props) {
  const entries = Object.entries(facet).sort(([, a], [, b]) => b - a)
  if (entries.length === 0) return null

  const max = Math.max(1, ...entries.map(([, c]) => c))
  const anySelected = selected.length > 0

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([code, count], index) => {
        const isActive = selected.includes(code)
        const color = getColor(code, index)
        return (
          <button
            key={code}
            type="button"
            onClick={() => onToggle(code)}
            aria-pressed={isActive}
            className={cn(
              "group flex w-full flex-col gap-1 rounded-md p-1 text-left transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              anySelected && !isActive && "opacity-50 hover:opacity-100",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-2.5 shrink-0",
                  swatchShape === "dot" ? "rounded-full" : "rounded-[2px]",
                )}
                style={{ background: color }}
                aria-hidden
              />
              <span className="flex-1 truncate text-xs text-foreground">
                {getLabel(code)}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {count.toLocaleString("fr-FR")}
              </span>
            </div>
            <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.round((count / max) * 100)}%`,
                  background: color,
                }}
              />
            </span>
          </button>
        )
      })}
    </div>
  )
}
