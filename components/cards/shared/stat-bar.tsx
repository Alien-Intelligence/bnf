"use client"

// components/cards/shared/stat-bar.tsx
// CardSharedStatBar — one clickable, proportional bucket bar: a colour chip, a
// label with a sub-line, a right-aligned count, and a fill whose width is the
// count against the largest bucket in its group.
//
// Shared by the two breakdown cards in the corpus filter drawer — numérisation
// (what we EXPECTED of each document) and indexation (what BECAME of it). They
// render identically and filter identically; only the vocabulary differs, so
// the bar itself lives here rather than once per card.

import { cn } from "@/lib/utils"

interface CardSharedStatBarProps {
  label: string
  sub: string
  count: number
  /** Largest count in the group — the bar's 100% reference. Never 0. */
  max: number
  /** CSS colour for the chip and the fill, e.g. "var(--info)". */
  color: string
  /** This bucket is part of the active filter. */
  active: boolean
  /** Something else in the group is selected and this one is not. */
  dimmed: boolean
  onClick: () => void
}

export function CardSharedStatBar({
  label,
  sub,
  count,
  max,
  color,
  active,
  dimmed,
  onClick,
}: CardSharedStatBarProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-md p-1 text-left transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dimmed && "opacity-50 hover:opacity-100",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-foreground">
          <span
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: color }}
            aria-hidden
          />
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">· {sub}</span>
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {count.toLocaleString("fr-FR")}
        </span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-secondary">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.round((count / max) * 100)}%`, background: color }}
        />
      </span>
    </button>
  )
}
