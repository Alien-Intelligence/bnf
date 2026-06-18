"use client"

// components/cards/corpus/facet-chips.tsx
// Reusable chip group for corpus facet filters.
// Each chip is a Badge — active (filled) or inactive (outline).
// Counts are shown in muted text after the label.

import { Badge } from "@/components/ui/badge"

interface Props {
  /** Map of code → document count for this facet. */
  facet: Record<string, number>
  /** Currently selected codes. */
  selected: string[]
  /** Called when a chip is clicked; toggles selection in the parent. */
  onToggle: (code: string) => void
  /** Optional display-label resolver; falls back to the raw code. */
  getLabel?: (code: string) => string
  /** Optional Tailwind colour class resolver for active chips. */
  getColor?: (code: string) => string
}

export function CardCorpusFacetChips({
  facet,
  selected,
  onToggle,
  getLabel,
  getColor,
}: Props) {
  const entries = Object.entries(facet).sort(([, a], [, b]) => b - a)

  if (entries.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([code, count]) => {
        const isActive = selected.includes(code)
        const label = getLabel ? getLabel(code) : code
        const colorClass = getColor ? getColor(code) : undefined

        return (
          <button
            key={code}
            type="button"
            onClick={() => onToggle(code)}
            className="flex items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-pressed={isActive}
          >
            {isActive ? (
              <Badge
                className={
                  colorClass
                    ? `${colorClass} border-0 font-normal cursor-pointer`
                    : "font-normal cursor-pointer"
                }
              >
                {label}
                <span className="ml-1 text-xs opacity-70 tabular-nums">
                  {count}
                </span>
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="font-normal cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {label}
                <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                  {count}
                </span>
              </Badge>
            )}
          </button>
        )
      })}
    </div>
  )
}
