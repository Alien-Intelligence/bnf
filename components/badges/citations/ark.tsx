"use client"

// components/badges/citations/ark.tsx
// BadgeArkCitation — the inline `[[ark|label|folio]]` pill in a note body
// (playbook/citations.md). Clicking it opens SheetCitationSource.
//
// A folio whose OCR is low (feedback 2026-09-29 #7 — isLowOcr, decided by
// code) gets a warning marker inside the pill, a warning border tint, the
// TooltipCitationLowOcr explanation and an aria-label that says so. No marker
// when the folio's quality is unknown, unscored or not low (plan D3): a
// mistral or vision folio has no word confidence and is never flagged.

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { TooltipCitationLowOcr } from "@/components/tooltips/citations/low-ocr"
import { ocrPercent } from "@/lib/citations/ocr"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { cn } from "@/lib/utils"
import type { FolioOcrView } from "@/models/documents/schema"

interface BadgeArkCitationProps {
  citation: ParsedCitation
  /** The cited folio's stored OCR quality; undefined while not synced. */
  ocr: FolioOcrView | undefined
  onClick: (c: ParsedCitation) => void
}

export function BadgeArkCitation({ citation, ocr, onClick }: BadgeArkCitationProps) {
  const t = useTranslations("citations.ocr")
  const lowQuality = ocr !== undefined && ocr.low && ocr.ocrQuality !== null
    ? ocrPercent(ocr.ocrQuality)
    : null
  const text = `${citation.label} · f${citation.folio}`

  const pill = (
    <button
      type="button"
      onClick={() => onClick(citation)}
      aria-label={lowQuality === null ? undefined : `${text} — ${t("lowPill", { quality: lowQuality })}`}
      className="mx-0.5 inline-block align-middle"
    >
      <Badge
        className={cn(
          "border bg-brand-teal/12 font-mono text-xs text-brand-teal transition-colors hover:bg-brand-teal/20",
          lowQuality === null ? "border-brand-teal/30" : "border-warning/60",
        )}
      >
        {lowQuality === null ? null : (
          <TriangleAlert className="size-3 shrink-0 text-warning" strokeWidth={2} aria-hidden />
        )}
        {text}
      </Badge>
    </button>
  )

  if (lowQuality === null) return pill
  return <TooltipCitationLowOcr quality={lowQuality} trigger={pill} />
}
