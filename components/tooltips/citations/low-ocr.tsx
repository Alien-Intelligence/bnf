"use client"

// components/tooltips/citations/low-ocr.tsx
// TooltipCitationLowOcr — the hover/focus explanation on a low-OCR citation
// pill (feedback 2026-09-29 #7): the folio's measured OCR quality and the
// invitation to check the quotation against the source. Extracted per
// playbook/componentization.md (no raw <Tooltip> inside a feature component).

import type { ReactElement } from "react"
import { useTranslations } from "next-intl"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface TooltipCitationLowOcrProps {
  /** The folio's mean word confidence as a whole percentage (ocrPercent). */
  quality: number
  /** The element the tooltip attaches to — it keeps its own handlers. */
  trigger: ReactElement
}

export function TooltipCitationLowOcr({ quality, trigger }: TooltipCitationLowOcrProps) {
  const t = useTranslations("citations.ocr")
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{t("lowPill", { quality })}</TooltipContent>
    </Tooltip>
  )
}
