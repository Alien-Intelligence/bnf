// components/events/agent/memory-event.tsx
// Renders a single memory-write domain event row inside the chat panel.
// Client component — uses translations.

"use client"

import { Lightbulb } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  kind: "write"
  section: string
}

export function EventMemoryRow({ section }: Props) {
  const t = useTranslations("corpus.events")

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Lightbulb className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t("memoryWrite", { section })}</span>
    </div>
  )
}
