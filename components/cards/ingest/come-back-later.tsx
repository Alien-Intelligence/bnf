"use client"

// components/cards/ingest/come-back-later.tsx
// Informational banner shown while an ingest job is running. Reassures the
// librarian that the cluster continues processing even if the tab is closed.
// No interactivity, no state — pure display.

import { useTranslations } from "next-intl"
import { Info } from "lucide-react"
import {
  Card,
  CardContent,
} from "@/components/ui/card"

export function CardComeBackLater() {
  const t = useTranslations("ingest.comeBackLater")

  return (
    <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30">
      <CardContent className="flex gap-3 pt-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
            {t("title")}
          </p>
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t("body")}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
