// components/events/agent/compaction-event.tsx
// Renders a subtle "conversation condensée" marker when the chat-sdk runtime
// folds older turns into a synopsis (agent-context-survival Slice 2). Shown only
// on a FRESH compaction (not on every turn's cache-reuse), so it reads as a
// one-off "we summarised the earlier part" note rather than recurring noise.
// Client component — uses translations.

"use client"

import { Layers } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  coveredMessageCount: number
}

export function EventCompactionRow({ coveredMessageCount }: Props) {
  const t = useTranslations("corpus.events")

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Layers className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t("compaction", { count: coveredMessageCount })}</span>
    </div>
  )
}
