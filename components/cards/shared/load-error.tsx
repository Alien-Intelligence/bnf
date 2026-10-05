"use client"

// components/cards/shared/load-error.tsx
// CardSharedLoadError — THE error state of an async block (playbook/ui-states.md
// "Error — visible, retriable, never silent"): a destructive-toned card saying
// what failed and offering a retry. Shared by the Carnet, the in-espace Carnet,
// the citation side panel and the corpus document panel so the error surface is
// the same everywhere.
//
//   layout="block"  — a whole region failed (centred, generous spacing);
//   layout="inline" — one line inside a panel or a list entry.

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface CardSharedLoadErrorProps {
  /** What could not be loaded, already translated. */
  message: string
  onRetry: () => void
  layout: "block" | "inline"
}

export function CardSharedLoadError({ message, onRetry, layout }: CardSharedLoadErrorProps) {
  const tCommon = useTranslations("common")
  return (
    <Card
      size="sm"
      role="alert"
      className={cn("bg-destructive/5 ring-destructive/30", layout === "block" && "py-8")}
    >
      <CardContent
        className={cn(
          "flex gap-3 text-muted-foreground",
          layout === "block" ? "flex-col items-center text-center text-sm" : "items-center text-[12.5px]",
        )}
      >
        <TriangleAlert
          className={cn("shrink-0 text-destructive", layout === "block" ? "size-5" : "size-4")}
          strokeWidth={1.8}
          aria-hidden
        />
        <span className={cn(layout === "inline" && "min-w-0 flex-1")}>{message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tCommon("tryAgain")}
        </Button>
      </CardContent>
    </Card>
  )
}
