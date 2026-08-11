"use client"

// components/cards/buffer/box.tsx
// CardBufferBox — the compact research-buffer ("tampon") pill at the bottom of
// the sessions rail, directly above the project-memory box. Mirrors
// CardMemoryBox: shows the candidate count + a preview and opens the full
// DialogBuffer. Always visible in the corpus step (even at 0) so the buffer is
// discoverable and never "vanishes" after a commit — it just shows 0 again.
// Reads the same useBuffer query the dialog does.

import { useTranslations } from "next-intl"
import { Layers, ChevronRight } from "lucide-react"
import { useBuffer } from "@/hooks/api/buffer"
import { BUFFER_PANEL_LIMIT } from "@/lib/constants"

interface Props {
  projectId: string
  onOpen: () => void
}

export function CardBufferBox({ projectId, onOpen }: Props) {
  const t = useTranslations("corpus.buffer")
  const { data } = useBuffer(projectId, {}, { limit: BUFFER_PANEL_LIMIT })

  const total = data?.total ?? 0
  const preview = data?.sample[0]?.title ?? null
  // When empty the pill is subdued; with candidates it takes the teal accent to
  // draw the eye (the librarian has something to curate/commit).
  const active = total > 0

  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        active
          ? "mx-2.5 mt-2.5 flex shrink-0 flex-col gap-1.5 rounded-lg border border-brand-teal/25 bg-brand-teal/5 px-3 py-2.5 text-left transition-colors hover:border-brand-teal/45 hover:bg-brand-teal/10"
          : "mx-2.5 mt-2.5 flex shrink-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      }
    >
      <span className="flex items-center gap-2">
        <Layers
          className={active ? "size-3.5 shrink-0 text-brand-teal" : "size-3.5 shrink-0 text-muted-foreground"}
          aria-hidden
        />
        <span
          className={
            active
              ? "font-mono text-[10px] font-semibold tracking-wide text-brand-teal uppercase"
              : "font-mono text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
          }
        >
          {t("title")}
        </span>
        <ChevronRight
          className={active ? "ml-auto size-3.5 shrink-0 text-brand-teal/60" : "ml-auto size-3.5 shrink-0 text-muted-foreground/50"}
          aria-hidden
        />
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {t("count", { count: total })}
        {active && preview ? ` · ${preview}` : ""}
      </span>
    </button>
  )
}
