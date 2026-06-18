"use client"

// components/dialogs/memory/index.tsx
// DialogMemory — read-only project memory with delete affordance.
// Three states: loading (skeleton sections) / error / success (sections list).

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertCircle } from "lucide-react"
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("dialog.title")} — {scopeLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
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
              <AlertCircle className="h-5 w-5" />
              <p className="text-sm">{tCommon("error")}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {tCommon("tryAgain")}
              </Button>
            </div>
          )}

          {!isLoading && !isError && data && (
            <>
              {data.sections.length === 0 ? (
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
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
