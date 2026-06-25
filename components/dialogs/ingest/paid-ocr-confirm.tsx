"use client"

// components/dialogs/ingest/paid-ocr-confirm.tsx
// Final confirmation before spending platform money on Mistral fallback OCR
// (the `sans_texte` opt-in on the Ingérer step), plus the budget-exceeded
// backstop. Two modes:
//   • "confirm" — client-driven, opened when the user has opted in and clicks
//     "Lancer". Confirming runs the ingest WITH paid OCR.
//   • "budget"  — server backstop: the opt-in slipped through over budget.
//     Informational; the regular ingest can still run with the opt-in dropped.

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

export type PaidOcrDialogState =
  | { mode: "confirm"; docCount: number; usd: number }
  | { mode: "budget"; usd: number; spentUsd: number; ceilingUsd: number }
  | null

interface Props {
  state: PaidOcrDialogState
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isPending: boolean
}

export function DialogIngestPaidOcrConfirm({
  state,
  onOpenChange,
  onConfirm,
  isPending,
}: Props) {
  const t = useTranslations("ingest.paidOcr")

  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {state?.mode === "budget" ? t("budgetTitle") : t("confirmTitle")}
          </DialogTitle>
          <DialogDescription>
            {state?.mode === "budget"
              ? t("budgetBody", {
                  cost: state.usd.toFixed(2),
                  spent: state.spentUsd.toFixed(2),
                  ceiling: state.ceilingUsd.toFixed(2),
                })
              : state?.mode === "confirm"
                ? t("confirmBody", {
                    count: state.docCount,
                    cost: state.usd.toFixed(2),
                  })
                : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {state?.mode === "budget" ? (
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
