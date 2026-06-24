"use client"

// components/layouts/workspace/health-status.tsx
// WorkspaceHealthStatus — the three-lane (App · Alien · BnF) health indicator
// in the workspace header, replacing the old static "MCP" dot. Each lane shows
// a colored dot (green / orange / red) derived from tool-call outcomes over the
// last HEALTH_WINDOW_MS, polled via useHealth(). A per-lane tooltip spells out
// the ok/error tallies. See models/health/schema.ts for the lane semantics.

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useHealth } from "@/hooks/api/health"
import type { HealthLane, HealthStatus, LaneHealth } from "@/models/health/schema"

const DOT_CLASS: Record<HealthStatus, string> = {
  green: "bg-success shadow-[0_0_8px_var(--success)]",
  orange: "bg-warning shadow-[0_0_8px_var(--warning)]",
  red: "bg-destructive shadow-[0_0_8px_var(--destructive)]",
}

const LANES: { lane: HealthLane; labelKey: "app" | "alien" | "bnf" }[] = [
  { lane: "app", labelKey: "app" },
  { lane: "alien", labelKey: "alien" },
  { lane: "bnf", labelKey: "bnf" },
]

function LaneDot({
  label,
  health,
  tooltip,
}: {
  label: string
  health: LaneHealth | undefined
  tooltip: string
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
      title={tooltip}
    >
      <span
        className={cn(
          "size-1.75 rounded-full",
          // No data yet → neutral, unlit dot rather than a misleading colour.
          health ? DOT_CLASS[health.status] : "bg-muted-foreground/40",
        )}
        aria-hidden
      />
      {label}
    </span>
  )
}

export function WorkspaceHealthStatus() {
  const t = useTranslations("health")
  const { data } = useHealth()

  return (
    <span className="hidden items-center gap-2.5 sm:inline-flex" aria-label={t("aria")}>
      {LANES.map(({ lane, labelKey }) => {
        const health = data?.[lane]
        const tooltip = !health
          ? t("tooltipIdle", { lane: t(labelKey) })
          : health.unreachable
            ? // Red because a hosted MCP server is unreachable, not from failed
              // tool calls — say so rather than showing a "0 errors" tally.
              t("tooltipUnreachable", { lane: t(labelKey) })
            : t("tooltip", {
                lane: t(labelKey),
                status: t(`status.${health.status}`),
                ok: health.ok,
                errors: health.error,
              })
        return (
          <LaneDot
            key={lane}
            label={t(labelKey)}
            health={health}
            tooltip={tooltip}
          />
        )
      })}
    </span>
  )
}
