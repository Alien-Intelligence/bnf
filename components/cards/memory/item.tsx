"use client"

// components/cards/memory/item.tsx
// One memory fact: `–` bullet + text + origin chip + a hover-revealed forget (×)
// button (design/BnF Corpus Research.dc.html lines 890-896).

import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useToast } from "@/components/ui/toast"
import { useForgetMemoryItem } from "@/hooks/api/memory"
import type { MemoryItem } from "@/models/memory/schema"

interface Props {
  item: MemoryItem
  projectId: string
  scope: "corpus" | "research"
}

const ORIGIN_KEY_MAP: Record<string, "origin.consigne" | "origin.action" | "origin.user" | "origin.deduit"> = {
  consigne: "origin.consigne",
  action: "origin.action",
  user: "origin.user",
  deduit: "origin.deduit",
}

export function CardMemoryItem({ item, projectId, scope }: Props) {
  const t = useTranslations("memory")
  const tCommon = useTranslations("common")
  const { toast } = useToast()
  const forget = useForgetMemoryItem(projectId, scope)

  const isSubmitting = forget.isPending
  const isErrored = forget.isError
  const originKey = ORIGIN_KEY_MAP[item.origin ?? "deduit"] ?? "origin.deduit"

  return (
    <div className="flex flex-col gap-0.5">
      <div className="group flex items-start gap-2.5 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-brand-teal/15 hover:bg-brand-teal/5">
        <span className="shrink-0 font-mono text-[13px] leading-relaxed text-brand-teal" aria-hidden>
          –
        </span>
        <p className="flex-1 text-[13px] leading-relaxed text-foreground/90">{item.text}</p>

        <span className="mt-0.5 shrink-0 rounded-full border px-2 py-px font-mono text-[9.5px] tracking-wide text-muted-foreground uppercase">
          {t(originKey)}
        </span>

        <button
          type="button"
          disabled={isSubmitting}
          aria-label={isSubmitting ? t("dialog.deleting") : t("dialog.delete")}
          title={t("dialog.delete")}
          onClick={() =>
            forget.mutate(
              { itemId: item.id },
              { onSuccess: () => toast(t("dialog.deleted")) },
            )
          }
          className={cn(
            "mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition",
            "opacity-0 group-hover:opacity-100 hover:bg-warning/10 hover:text-warning",
            "focus-visible:opacity-100 focus-visible:outline-none disabled:opacity-50",
          )}
        >
          <X className="size-3" />
        </button>
      </div>

      {isErrored && (
        <p className="px-2 text-xs text-destructive">{tCommon("error")}</p>
      )}
    </div>
  )
}
