"use client"

// components/dialogs/ingest/paid-ocr-confirm.tsx
// Per-ingestion confirmation before spending money on Mistral fallback OCR for
// `sans_texte` documents (digitized text with no BnF OCR layer). Renders two
// states off the submit outcome: the spend confirmation, and the budget-exceeded
// notice (when the confirmed cost would breach the project's OCR budget).
// Standard Dialog primitive (no AlertDialog in this codebase).

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { IngestSubmitPaidOcrResponse } from "@/models/ingest/types"

interface Props {
  /** The paid-OCR submit outcome, or null when the dialog is closed. */
  outcome: IngestSubmitPaidOcrResponse | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isPending: boolean
}

export function DialogIngestPaidOcrConfirm({
  outcome,
  onOpenChange,
  onConfirm,
  isPending,
}: Props) {
  const t = useTranslations("ingest.paidOcr")

  const open = outcome !== null
  const cost = outcome ? outcome.paidOcr.usd.toFixed(2) : "0.00"
  const count = outcome?.paidOcr.docCount ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {outcome?.kind === "budget_exceeded"
              ? t("budgetTitle")
              : t("confirmTitle")}
          </DialogTitle>
          <DialogDescription>
            {outcome?.kind === "budget_exceeded"
              ? t("budgetBody", {
                  cost,
                  spent: outcome.spentUsd.toFixed(2),
                  ceiling: outcome.ceilingUsd.toFixed(2),
                })
              : t("confirmBody", { count, cost })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {outcome?.kind === "budget_exceeded" ? (
            <Button onClick={() => onOpenChange(false)}>{t("close")}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() => onOpenChange(false)}
              >
                {t("dismiss")}
              </Button>
              <Button disabled={isPending} onClick={onConfirm}>
                {isPending ? t("confirming") : t("confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
