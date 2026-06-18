// components/events/agent/corpus-event.tsx
// Renders a single corpus domain event row inside the chat panel.
// Shows whether documents were added or removed, and the resulting version.
// Client component — uses translations.

"use client"

import { BookOpen, MinusCircle } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  kind: "add" | "remove"
  count: number
  versionSeq: number
}

export function EventCorpusRow({ kind, count, versionSeq }: Props) {
  const t = useTranslations("corpus.events")

  const key = kind === "add" ? "added" : "removed"
  const Icon = kind === "add" ? BookOpen : MinusCircle

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t(key, { count, versionSeq })}</span>
    </div>
  )
}
