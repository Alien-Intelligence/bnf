"use client"

// components/dialogs/memory/index.tsx
// DialogMemory — the project-memory file, styled to the Alien × BnF design
// (design/BnF Corpus Research.dc.html lines 863-910): brain header + "persistante"
// chip + description, `##` section eyebrows with `–` bullets and origin chips, an
// auto-update footnote. Read-only with a per-item forget affordance.

import { useTranslations } from "next-intl"
import { AlertCircle, Bot, Brain, Lock } from "lucide-react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { useMemory } from "@/hooks/api/memory"
import { CardMemorySection } from "@/components/cards/memory/section"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  scope: "corpus" | "research"
}

export function DialogMemory({ open, onOpenChange, projectId, scope }: Props) {
  const t = useTranslations("memory")
  const tCommon = useTranslations("common")
  const { data, isLoading, isError, refetch } = useMemory(projectId, scope)

  const scopeLabel =
    scope === "corpus" ? t("dialog.scopeCorpus") : t("dialog.scopeResearch")
  const count = data?.sections.reduce((n, s) => n + s.items.length, 0) ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-8 tracking-tight">
            <Brain className="size-4 shrink-0 text-brand-teal" aria-hidden />
            <span>
              {t("dialog.title")} — {scopeLabel}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-brand-teal/30 px-2 py-px font-mono text-[9px] tracking-wide text-brand-teal uppercase">
              <Lock className="size-2.5" aria-hidden />
              {t("dialog.persistent")}
            </span>
          </DialogTitle>
          <DialogDescription className="max-w-[62ch] text-xs leading-relaxed">
            {t("dialog.description")} {t("box.count", { count })}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto px-5 py-4">
          {isLoading && (
            <>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-8 w-full" />
              </div>
            </>
          )}

          {isError && (
            <div className="flex flex-col items-center gap-3 py-8 text-destructive">
              <AlertCircle className="size-5" />
              <p className="text-sm">{tCommon("error")}</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                {tCommon("tryAgain")}
              </Button>
            </div>
          )}

          {!isLoading && !isError && data && (
            data.sections.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("dialog.empty")}
              </p>
            ) : (
              data.sections.map((section) => (
                <CardMemorySection
                  key={section.title}
                  section={section}
                  projectId={projectId}
                  scope={scope}
                />
              ))
            )
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <Bot className="size-3.5 shrink-0 text-brand-teal" aria-hidden />
            <span className="truncate">{t("dialog.footnote")}</span>
          </span>
          <DialogClose render={<Button size="sm" />}>{tCommon("close")}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}
