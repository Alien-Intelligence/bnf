"use client"

// components/badges/tools/mutation-pill.tsx
// BadgeToolMutation — a corpus add/remove rendered as the prototype's count
// pill (design/BnF Corpus Research.dc.html lines 2004-2007): teal "+N documents
// ajoutés au corpus" for adds, amber "−N documents retirés" for removes.

import { Minus, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface Props {
  kind: "add" | "remove"
  count: number | null
  /** Supplied ARKs skipped as duplicates (add only); shown when > 0. */
  duplicates?: number | null
  running: boolean
  isError: boolean
}

export function BadgeToolMutation({ kind, count, duplicates, running, isError }: Props) {
  const t = useTranslations("tools.parts")
  const Icon = kind === "add" ? Plus : Minus

  const base = isError
    ? t("failed")
    : running
      ? kind === "add"
        ? t("adding")
        : t("removing")
      : count !== null
        ? kind === "add"
          ? t("added", { count })
          : t("removed", { count })
        : kind === "add"
          ? t("addedUnknown")
          : t("removedUnknown")

  // Append the duplicate count for a settled add, when any were skipped.
  const showDup =
    kind === "add" && !running && !isError && duplicates != null && duplicates > 0
  const label = showDup ? `${base} · ${t("duplicates", { count: duplicates })}` : base

  return (
    <div
      className={cn(
        "animate-bnf-up inline-flex items-center gap-1.75 self-start rounded-md border px-2.75 py-1.5 font-mono text-[11.5px]",
        isError
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : kind === "add"
            ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal"
            : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{label}</span>
    </div>
  )
}
