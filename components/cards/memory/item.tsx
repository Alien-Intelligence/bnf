"use client"

// components/cards/memory/item.tsx
// Renders a single memory item with an origin badge and a delete button.
// Three states: idle / submitting (disabled) / errored (inline red message).

import { Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
      <div className="flex items-start gap-2 py-1.5">
        <p className="flex-1 text-sm text-foreground leading-snug">{item.text}</p>

        <Badge variant="secondary" className="shrink-0 text-xs">
          {t(originKey)}
        </Badge>

        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          disabled={isSubmitting}
          aria-label={isSubmitting ? t("dialog.deleting") : t("dialog.delete")}
          onClick={() =>
            forget.mutate(
              { itemId: item.id },
              { onSuccess: () => toast(t("dialog.deleted")) },
            )
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="sr-only">
            {isSubmitting ? t("dialog.deleting") : t("dialog.delete")}
          </span>
        </Button>
      </div>

      {isErrored && (
        <p className="text-xs text-destructive">{tCommon("error")}</p>
      )}
    </div>
  )
}
