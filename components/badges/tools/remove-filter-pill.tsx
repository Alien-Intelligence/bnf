"use client"

// components/badges/tools/remove-filter-pill.tsx
// BadgeToolRemoveFilter — the bulk corpus_remove_by_filter rendered in the same
// pill language as the +N/−N mutation pill, but with HONEST states: a dry-run
// removes nothing, so it must read as a preview ("N match"), never as "−N
// removed". Four settled outcomes (preview / committed / empty-filter /
// no-match) plus running and error.

import { Filter, Minus, Search } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { RemoveByFilterView } from "@/lib/tools/display"

interface Props {
  view: RemoveByFilterView
  running: boolean
  isError: boolean
}

type Tone = "info" | "warning" | "muted"

const TONE_CLASS: Record<Tone, string> = {
  info: "border-info/30 bg-info/10 text-info",
  warning: "border-warning/30 bg-warning/10 text-warning",
  muted: "border-border bg-muted/40 text-muted-foreground",
}

export function BadgeToolRemoveFilter({ view, running, isError }: Props) {
  const t = useTranslations("tools.parts")

  let Icon = Filter
  let tone: Tone = "muted"
  let label: string

  if (isError) {
    tone = "warning"
    label = t("failed")
  } else if (running || view === null) {
    // Running, or settled but result not yet parsed: neutral "scanning" state.
    Icon = Search
    tone = "muted"
    label = t("removingByFilter")
  } else if (view.status === "empty_filter") {
    tone = "warning"
    label = t("emptyFilter")
  } else if (view.status === "dry_run") {
    // Preview only — nothing removed. Info tone, "match" wording, no minus.
    Icon = Search
    tone = "info"
    label = t("previewMatched", { count: view.matched })
  } else if (view.removed > 0) {
    // Committed removal — the amber −N pill, matching corpus_remove.
    Icon = Minus
    tone = "warning"
    label = t("removed", { count: view.removed })
  } else {
    // Committed, but the filter matched nothing.
    tone = "muted"
    label = t("noMatch")
  }

  return (
    <div
      className={cn(
        "animate-bnf-up inline-flex items-center gap-1.75 self-start rounded-md border px-2.75 py-1.5 font-mono text-[11.5px]",
        TONE_CLASS[tone],
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{label}</span>
    </div>
  )
}
