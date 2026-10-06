"use client"

// components/cards/notes/low-ocr-banner.tsx
// CardNoteLowOcrBanner — the ONE note-level banner carrying BnF's disclaimer
// (feedback 2026-09-29 #7) when at least one text citation of the note points
// at a low-OCR folio. Rendered by NoteBody (plan D14), the renderer every note
// view shares, so no view can forget it.

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Card, CardContent } from "@/components/ui/card"

export function CardNoteLowOcrBanner() {
  const t = useTranslations("citations.ocr")
  return (
    <Card
      size="sm"
      role="note"
      aria-label={t("bannerLabel")}
      className="mb-5 bg-warning/8 ring-warning/35"
    >
      <CardContent className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.8} aria-hidden />
        <p className="text-[13px] leading-relaxed text-neutral-200">{t("disclaimer")}</p>
      </CardContent>
    </Card>
  )
}
