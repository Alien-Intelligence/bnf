"use client"

// components/cards/memory/box.tsx
// CardMemoryBox — the compact, teal-tinted project-memory info box shown at the
// bottom of the sessions rail (design/BnF Corpus Research.dc.html lines 170-183).
// Shows what the agent durably remembers (item count + a preview) and opens the
// full DialogMemory. Reads the same useMemory query the dialog does.

import { useTranslations } from "next-intl"
import { Brain, ChevronRight } from "lucide-react"
import { useMemory } from "@/hooks/api/memory"

interface Props {
  projectId: string
  scope: "corpus" | "research"
  onOpen: () => void
}

export function CardMemoryBox({ projectId, scope, onOpen }: Props) {
  const t = useTranslations("memory")
  const { data } = useMemory(projectId, scope)

  const items = data?.sections.flatMap((s) => s.items) ?? []
  const count = items.length
  const preview = items[0]?.text

  return (
    <button
      type="button"
      onClick={onOpen}
      className="m-2.5 flex shrink-0 flex-col gap-1.5 rounded-lg border border-brand-teal/25 bg-brand-teal/5 px-3 py-2.5 text-left transition-colors hover:border-brand-teal/45 hover:bg-brand-teal/10"
    >
      <span className="flex items-center gap-2">
        <Brain className="size-3.5 shrink-0 text-brand-teal" aria-hidden />
        <span className="font-mono text-[10px] font-semibold tracking-wide text-brand-teal uppercase">
          {t("dialog.title")}
        </span>
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-brand-teal/60" aria-hidden />
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {t("box.count", { count })}
        {preview ? ` · ${preview}` : ""}
      </span>
    </button>
  )
}
