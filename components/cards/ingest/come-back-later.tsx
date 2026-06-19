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
    <Card className="border-brand-teal/25 bg-brand-teal/6">
      <CardContent className="flex gap-3">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-teal" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">{t("title")}</p>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </div>
      </CardContent>
    </Card>
  )
}
