// components/events/agent/subagent-event.tsx
// Renders a spawn_research sub-agent domain event in the chat. A sub-agent runs
// in an isolated context for a while (a heavy sweep / RAG fan-out), so its
// activity gets a PROMINENT card — not a one-line note — so the librarian
// clearly sees "a sub-agent is working" while it runs, then a compact summary
// when it returns. (agent-context-survival Slice 1.)
// Client component — uses translations.

"use client"

import { Bot, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

type Props =
  | { kind: "start" }
  | { kind: "done"; toolCalls: number; buffered?: number }

export function EventSubagentRow(props: Props) {
  const t = useTranslations("corpus.events")

  if (props.kind === "start") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-3 py-2">
        <Loader2 className="size-4 shrink-0 animate-spin text-brand-teal" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-brand-teal">{t("subagentStart")}</span>
          <span className="text-[11px] text-muted-foreground">{t("subagentStartHint")}</span>
        </div>
      </div>
    )
  }

  const label =
    props.buffered !== undefined
      ? t("subagentDoneBuffered", { toolCalls: props.toolCalls, buffered: props.buffered })
      : t("subagentDone", { toolCalls: props.toolCalls })

  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2">
      <Bot className="size-4 shrink-0 text-brand-teal" aria-hidden="true" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
