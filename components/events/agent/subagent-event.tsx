// components/events/agent/subagent-event.tsx
// Renders a spawn_research sub-agent domain event row inside the chat panel: a
// subtle "sous-agent en cours / terminé" marker so the librarian sees that a
// heavy sweep was delegated to an isolated context (agent-context-survival).
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
      <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span>{t("subagentStart")}</span>
      </div>
    )
  }

  const label =
    props.buffered !== undefined
      ? t("subagentDoneBuffered", { toolCalls: props.toolCalls, buffered: props.buffered })
      : t("subagentDone", { toolCalls: props.toolCalls })

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Bot className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
