// components/cards/shared/stat.tsx
// CardSharedStat — the KPI tile used across the corpus comprehension panel
// (count / période / types / langues) and the admin usage screen. A bordered
// card with a muted label, a large mono value, and an optional sub-line.
// Mirrors design/BnF Corpus Research.dc.html summary tile (lines 289-296).

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface CardSharedStatProps {
  label: string
  value: string | number
  sub?: string
  /** Tint the value with the brand teal (e.g. the "Ingérables" highlight). */
  accent?: boolean
}

export function CardSharedStat({
  label,
  value,
  sub,
  accent = false,
}: CardSharedStatProps) {
  return (
    <Card className="gap-0 rounded-lg [--card-spacing:--spacing(3.5)]">
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span
          className={cn(
            "font-mono text-[22px] font-semibold leading-tight",
            accent && "text-brand-teal",
          )}
        >
          {value}
        </span>
        {sub && (
          <span className="text-[10.5px] text-muted-foreground/80">{sub}</span>
        )}
      </CardContent>
    </Card>
  )
}
