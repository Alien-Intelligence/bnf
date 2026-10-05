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
import { CardAgentSubagentRun } from "@/components/cards/agent/subagent-run"
import { SUBAGENT_RUN_STATUS, type SubagentRunState } from "@/lib/tools/subagent-runs"

type Props = { run: SubagentRunState }

export function EventSubagentRow({ run }: Props) {
  const t = useTranslations("corpus.events")
  /** What a stopped run had staged — never lost from the row. */
  const staged = (buffered: number | undefined) =>
    buffered !== undefined && buffered > 0 ? t("subagentStagedBeforeStop", { buffered }) : null

  switch (run.status) {
    case SUBAGENT_RUN_STATUS.RUNNING:
      return (
        <CardAgentSubagentRun tone="active" icon={Loader2} spin text={t("subagentStart")} details={[run.label, t("subagentStartHint")]} />
      )
    case SUBAGENT_RUN_STATUS.ERROR:
      return (
        <CardAgentSubagentRun
          tone="failed"
          icon={TriangleAlert}
          text={t("subagentError", { toolCalls: run.toolCalls })}
          details={[staged(run.buffered), run.label]}
        />
      )
    case SUBAGENT_RUN_STATUS.TIMEOUT:
      return (
        <CardAgentSubagentRun tone="failed" icon={TriangleAlert} text={t("subagentTimeout")} details={[staged(run.buffered), run.label]} />
      )
    case SUBAGENT_RUN_STATUS.DONE:
      return (
        <CardAgentSubagentRun
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
        <CardAgentSubagentRun tone="muted" icon={CircleSlash} text={t("subagentAborted")} details={[staged(run.buffered), run.label]} />
      )
    case SUBAGENT_RUN_STATUS.INTERRUPTED:
      return <CardAgentSubagentRun tone="muted" icon={CircleSlash} text={t("subagentInterrupted")} details={[run.label]} />
    case SUBAGENT_RUN_STATUS.UNREADABLE:
      return <CardAgentSubagentRun tone="muted" icon={CircleSlash} text={t("subagentUnreadable")} details={[]} />
  }
}
