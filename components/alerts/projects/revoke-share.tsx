"use client"

// components/alerts/projects/revoke-share.tsx
// AlertDialogProjectRevokeShare — confirms revoking a grant that derived
// research workspaces are built on: revoking severs their corpus, so it names
// how many before anything happens. A grant nothing is built on is revoked in
// one click and never reaches this dialog (DialogProjectShare decides).
//
// Nested in the share dialog, so its state lives at the share dialog's level
// (playbook/componentization.md, "a confirmation nested in a dialog"). While
// the revoke is in flight it cannot be dismissed — not by its buttons, not by
// Escape or the backdrop.

import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface AlertDialogProjectRevokeShareProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupName: string
  derivedCount: number
  onConfirm: () => void
  pending: boolean
}

export function AlertDialogProjectRevokeShare({
  open,
  onOpenChange,
  groupName,
  derivedCount,
  onConfirm,
  pending,
}: AlertDialogProjectRevokeShareProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("revokeTitle", { name: groupName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("revokeConfirm", { count: derivedCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            {t("revokeConfirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
