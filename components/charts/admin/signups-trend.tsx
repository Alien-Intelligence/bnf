// components/charts/admin/signups-trend.tsx
// ChartAdminSignupsTrend — a dependency-free vertical bar chart of daily
// sign-ups over a window (default 30 days). No chart library is installed, so
// this renders lightweight CSS bars; each bar carries a native title tooltip
// with the exact day + count. Presentational only.

interface SignupDay {
  date: string
  count: number
}

interface ChartAdminSignupsTrendProps {
  data: SignupDay[]
  /** Locale for the tooltip date formatting. */
  locale: string
}

export function ChartAdminSignupsTrend({
  data,
  locale,
}: ChartAdminSignupsTrendProps) {
  const max = Math.max(1, ...data.map((d) => d.count))

  return (
    <div className="flex h-32 items-end gap-0.5">
      {data.map((d) => {
        const heightPct = (d.count / max) * 100
        const label = `${new Date(d.date).toLocaleDateString(locale)} — ${d.count}`
        return (
          <div
            key={d.date}
            title={label}
            className="flex flex-1 items-end"
            style={{ height: "100%" }}
          >
            <div
              className="w-full rounded-t-sm bg-brand-teal/70 transition-colors hover:bg-brand-teal"
              style={{ height: `${Math.max(heightPct, d.count > 0 ? 4 : 0)}%` }}
              aria-hidden
            />
          </div>
        )
      })}
    </div>
  )
}
