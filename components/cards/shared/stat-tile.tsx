// components/cards/shared/stat-tile.tsx
// CardSharedStatTile — the dense KPI tile used inside the corpus breakdown
// cards: a small muted label over a large mono figure, optionally "N / total".
//
// Distinct from CardSharedStat, which is the full-size tile of the summary row
// (a Card, larger type). These sit two-up inside a card that is itself inside
// the filter drawer, so they are deliberately tighter. Both breakdown cards —
// numérisation and indexation — render this, so the two stay identical.
//
// `tone` marks the tile that carries the number worth reacting to: "brand" for
// a healthy headline figure, "warning" for a count the librarian should act on,
// "plain" for a neutral denominator.

import { cn } from "@/lib/utils"

type StatTileTone = "plain" | "brand" | "warning"

interface CardSharedStatTileProps {
  label: string
  value: number
  /** Denominator, rendered as "value / of". Omit for a bare figure. */
  of?: number
  tone?: StatTileTone
}

const TONE_BORDER: Record<StatTileTone, string> = {
  plain: "",
  brand: "border-brand-teal/30 bg-brand-teal/5",
  warning: "border-warning/30 bg-warning/5",
}

const TONE_TEXT: Record<StatTileTone, string> = {
  plain: "text-muted-foreground",
  brand: "text-brand-teal",
  warning: "text-warning",
}

const TONE_VALUE: Record<StatTileTone, string> = {
  plain: "",
  brand: "text-brand-teal",
  warning: "text-warning",
}

export function CardSharedStatTile({
  label,
  value,
  of,
  tone = "plain",
}: CardSharedStatTileProps) {
  return (
    <div className={cn("rounded-md border px-3 py-2", TONE_BORDER[tone])}>
      <div className={cn("text-[10.5px]", TONE_TEXT[tone])}>{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[17px] font-semibold tabular-nums",
          TONE_VALUE[tone],
        )}
      >
        {value.toLocaleString("fr-FR")}
        {of !== undefined && (
          <span className="text-[11px] text-muted-foreground">
            {" "}
            / {of.toLocaleString("fr-FR")}
          </span>
        )}
      </div>
    </div>
  )
}
