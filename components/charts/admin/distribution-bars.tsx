// components/charts/admin/distribution-bars.tsx
// ChartAdminDistributionBars — horizontal labelled bars for a small categorical
// breakdown (e.g. feedback by rating or by target). No chart library installed,
// so bars are CSS widths proportional to the largest value. Presentational only.

interface DistributionItem {
  /** Human label already resolved by the caller (i18n happens upstream). */
  label: string
  value: number
}

interface ChartAdminDistributionBarsProps {
  items: DistributionItem[]
  locale: string
}

export function ChartAdminDistributionBars({
  items,
  locale,
}: ChartAdminDistributionBarsProps) {
  const max = Math.max(1, ...items.map((i) => i.value))

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const widthPct = (item.value / max) * 100
        return (
          <div key={item.label} className="flex items-center gap-3 text-sm">
            <span className="w-28 shrink-0 truncate text-muted-foreground">
              {item.label}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-brand-teal/70"
                style={{ width: `${widthPct}%` }}
                aria-hidden
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono tabular-nums">
              {item.value.toLocaleString(locale)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
