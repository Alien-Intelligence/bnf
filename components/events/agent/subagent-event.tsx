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

import { Bot, CircleSlash, Loader2, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import type { SubagentRunState } from "@/lib/tools/subagent-runs"

type Props = { run: SubagentRunState }

export function EventSubagentRow({ run }: Props) {
  const t = useTranslations("corpus.events")

  if (run.status === "running") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-3 py-2">
        <Loader2 className="size-4 shrink-0 animate-spin text-brand-teal" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-brand-teal">{t("subagentStart")}</span>
          <span className="truncate text-[11px] text-muted-foreground">{run.label}</span>
          <span className="text-[11px] text-muted-foreground">{t("subagentStartHint")}</span>
        </div>
      </div>
    )
  }

  if (run.status === "error" || run.status === "timeout") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-destructive">
            {run.status === "error" ? t("subagentError", { toolCalls: run.toolCalls }) : t("subagentTimeout")}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{run.label}</span>
        </div>
      </div>
    )
  }

  if (run.status === "done") {
    const label =
      run.buffered !== undefined
        ? t("subagentDoneBuffered", { toolCalls: run.toolCalls, buffered: run.buffered })
        : t("subagentDone", { toolCalls: run.toolCalls })

    return (
      <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2">
        <Bot className="size-4 shrink-0 text-brand-teal" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="truncate text-[11px] text-muted-foreground">{run.label}</span>
        </div>
      </div>
    )
  }

  // aborted (the turn was cancelled) or interrupted (the turn ended with no
  // terminal event): muted, never a spinner.
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2">
      <CircleSlash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">
          {run.status === "aborted" ? t("subagentAborted") : t("subagentInterrupted")}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{run.label}</span>
      </div>
    </div>
  )
}
