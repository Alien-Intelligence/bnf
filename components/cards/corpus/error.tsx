"use client"

// components/cards/corpus/error.tsx
// Error state for corpus document list — visible, retriable, never silent.
// Client component: onRetry callback.

import { AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

interface Props {
  onRetry: () => void
}

export function CardCorpusError({ onRetry }: Props) {
  const t = useTranslations("common")

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-destructive">
      <AlertCircle className="h-6 w-6" />
      <p className="text-sm">{t("error")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("tryAgain")}
      </Button>
    </div>
  )
}
