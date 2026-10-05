// components/cards/agent/subagent-run.tsx
// The card one spawn_research run renders as in the chat: an icon, a status
// line and its detail lines (the staged count, the task excerpt), in one of
// four tones. One component with variants, so every run state looks like the
// same object (playbook/componentization.md).

"use client"

import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** The card's look per tone. */
const TONE = {
  active: { card: "bg-brand-teal/5 ring-brand-teal/30", icon: "text-brand-teal", text: "font-medium text-brand-teal" },
  failed: { card: "bg-destructive/5 ring-destructive/30", icon: "text-destructive", text: "text-destructive" },
  done: { card: "", icon: "text-brand-teal", text: "text-muted-foreground" },
  muted: { card: "bg-muted/40", icon: "text-muted-foreground", text: "text-muted-foreground" },
} as const

export type SubagentRunTone = keyof typeof TONE

interface Props {
  tone: SubagentRunTone
  icon: LucideIcon
  /** Spin the icon (only while the run is running). */
  spin?: boolean
  text: string
  /** Detail lines, in order; null or empty lines are skipped. */
  details: ReadonlyArray<string | null>
}

export function CardAgentSubagentRun({ tone, icon: Icon, spin = false, text, details }: Props) {
  const look = TONE[tone]
  // Keyed by position: two detail lines may carry the same text.
  const lines = details.flatMap((d, position) => (d !== null && d !== "" ? [{ position, d }] : []))
  return (
    <Card size="sm" className={cn("flex-row items-center gap-2.5 px-3 py-2", look.card)}>
      <Icon className={cn("size-4 shrink-0", look.icon, spin && "animate-spin")} aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className={cn("text-xs", look.text)}>{text}</span>
        {lines.map(({ position, d }) => (
          <span key={position} className="truncate text-[11px] text-muted-foreground">
            {d}
          </span>
        ))}
      </div>
    </Card>
  )
}
