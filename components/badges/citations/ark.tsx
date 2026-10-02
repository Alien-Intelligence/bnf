"use client"

// components/badges/citations/ark.tsx
// BadgeArkCitation — the inline `[[ark|label|folio]]` pill in a note body
// (playbook/citations.md). Clicking it opens SheetCitationSource.
//
// Its folio's OCR state (feedback 2026-09-29 #7, lib/ocr/quality.ts):
//   - recorded and low → a warning marker inside the pill, a warning border
//     tint, the TooltipCitationLowOcr explanation and an aria-label saying so;
//   - not synced / not recorded → no visual marker (plan D3: only a measured
//     low quality is flagged) but the aria-label says the quality is not
//     available, so "unknown" is never announced as "fine";
//   - recorded and not low, or a mistral/vision page → the plain pill.

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { TooltipCitationLowOcr } from "@/components/tooltips/citations/low-ocr"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { ocrPercent, type FolioOcrState } from "@/lib/ocr/quality"
import { cn } from "@/lib/utils"

interface BadgeArkCitationProps {
  citation: ParsedCitation
  /** The cited folio's OCR state (folioOcrState). */
  ocr: FolioOcrState
  onClick: (c: ParsedCitation) => void
}

/** The measured quality as a percentage when the folio is low, else null. */
function lowPercent(ocr: FolioOcrState): number | null {
  if (ocr.kind !== "recorded" || !ocr.view.low || ocr.view.ocrQuality === null) return null
  return ocrPercent(ocr.view.ocrQuality)
}

export function BadgeArkCitation({ citation, ocr, onClick }: BadgeArkCitationProps) {
  const t = useTranslations("citations.ocr")
  const lowQuality = lowPercent(ocr)
  const text = `${citation.label} · f${citation.folio}`
  const unknown = ocr.kind === "not_synced" || ocr.kind === "not_recorded"

  let ariaLabel: string | undefined
  if (lowQuality !== null) ariaLabel = `${text} — ${t("lowPill", { quality: lowQuality })}`
  else if (unknown) ariaLabel = `${text} — ${t("pillUnavailable")}`

  const pill = (
    <button
      type="button"
      onClick={() => onClick(citation)}
      aria-label={ariaLabel}
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
