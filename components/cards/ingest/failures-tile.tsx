"use client"

// components/cards/ingest/failures-tile.tsx
// Small clickable tile showing the count of failed documents for the active
// ingest job. Clicking opens the SheetIngestFailures panel.
// Shown only when activeJob.stats.errors is non-empty.

import { AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

interface Props {
  count: number
  onOpen: () => void
}

export function CardIngestFailuresTile({ count, onOpen }: Props) {
  const t = useTranslations("ingest.failures")

  return (
    <Button
      variant="outline"
      className="flex items-center gap-2 border-destructive text-destructive hover:bg-destructive/10"
      onClick={onOpen}
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{t("tile", { count })}</span>
    </Button>
  )
}
