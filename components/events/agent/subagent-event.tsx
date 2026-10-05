// components/events/agent/subagent-event.tsx
// Renders one spawn_research sub-agent RUN in the chat. A sub-agent runs in an
// isolated context for a while (a heavy sweep / RAG fan-out), so its activity
// gets a PROMINENT card — not a one-line note — while it runs, then a compact
// summary when it returns. (agent-context-survival Slice 1.)
//
// One row per run, driven by its folded state (reduceSubagentRuns,
// lib/tools/subagent-runs.ts): the start and terminal events share a runId, so
// the spinner shows ONLY while the run is `running` (feedback #10e — on 0.18.1
// the start row spun forever beside its own "done" row). The task excerpt is
// the second line, so parallel sweeps are told apart.
// Client component — uses translations.

"use client"

import { Bot, CircleSlash, Loader2, TriangleAlert, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { SUBAGENT_RUN_STATUS, type SubagentRunState } from "@/lib/tools/subagent-runs"

type Props = { run: SubagentRunState }

/** The row's look per tone — one component, variants instead of four panels. */
const TONE = {
  active: { card: "bg-brand-teal/5 ring-brand-teal/30", icon: "text-brand-teal", text: "font-medium text-brand-teal" },
  failed: { card: "bg-destructive/5 ring-destructive/30", icon: "text-destructive", text: "text-destructive" },
  done: { card: "", icon: "text-brand-teal", text: "text-muted-foreground" },
  muted: { card: "bg-muted/40", icon: "text-muted-foreground", text: "text-muted-foreground" },
} as const

function RunRow({
  tone,
  icon: Icon,
  spin = false,
  text,
  details,
}: {
  tone: keyof typeof TONE
  icon: LucideIcon
  spin?: boolean
  text: string
  details: ReadonlyArray<string | null>
}) {
  const look = TONE[tone]
  return (
    <Card size="sm" className={cn("flex-row items-center gap-2.5 px-3 py-2", look.card)}>
      <Icon className={cn("size-4 shrink-0", look.icon, spin && "animate-spin")} aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className={cn("text-xs", look.text)}>{text}</span>
        {details
          .filter((d): d is string => d !== null && d !== "")
          .map((d) => (
            <span key={d} className="truncate text-[11px] text-muted-foreground">
              {d}
            </span>
          ))}
      </div>
    </Card>
  )
}

export function EventSubagentRow({ run }: Props) {
  const t = useTranslations("corpus.events")
  /** What a stopped run had staged — never lost from the row. */
  const staged = (buffered: number | undefined) =>
    buffered !== undefined && buffered > 0 ? t("subagentStagedBeforeStop", { buffered }) : null

  switch (run.status) {
    case SUBAGENT_RUN_STATUS.RUNNING:
      return (
        <RunRow tone="active" icon={Loader2} spin text={t("subagentStart")} details={[run.label, t("subagentStartHint")]} />
      )
    case SUBAGENT_RUN_STATUS.ERROR:
      return (
        <RunRow
          tone="failed"
          icon={TriangleAlert}
          text={t("subagentError", { toolCalls: run.toolCalls })}
          details={[staged(run.buffered), run.label]}
        />
      )
    case SUBAGENT_RUN_STATUS.TIMEOUT:
      return (
        <RunRow tone="failed" icon={TriangleAlert} text={t("subagentTimeout")} details={[staged(run.buffered), run.label]} />
      )
    case SUBAGENT_RUN_STATUS.DONE:
      return (
        <RunRow
          tone="done"
          icon={Bot}
          text={
            run.buffered !== undefined
              ? t("subagentDoneBuffered", { toolCalls: run.toolCalls, buffered: run.buffered })
              : t("subagentDone", { toolCalls: run.toolCalls })
          }
          details={[run.label]}
        />
      )
    // Cancelled with the turn, ended with no terminal event, or an event the
    // client could not read: muted, never a spinner.
    case SUBAGENT_RUN_STATUS.ABORTED:
      return (
        <RunRow tone="muted" icon={CircleSlash} text={t("subagentAborted")} details={[staged(run.buffered), run.label]} />
      )
    case SUBAGENT_RUN_STATUS.INTERRUPTED:
      return <RunRow tone="muted" icon={CircleSlash} text={t("subagentInterrupted")} details={[run.label]} />
    case SUBAGENT_RUN_STATUS.UNREADABLE:
      return <RunRow tone="muted" icon={CircleSlash} text={t("subagentUnreadable")} details={[]} />
  }
}
