"use client"

// components/alerts/projects/revoke-share.tsx
// AlertDialogProjectRevokeShare — confirms revoking a grant that derived
// research workspaces are built on: revoking severs their corpus, so it names
// how many before anything happens. A grant nothing is built on is revoked in
// one click and never reaches this dialog (DialogProjectShare decides).

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
import type { ShareWithGroup } from "@/models/projects/schema"

interface AlertDialogProjectRevokeShareProps {
  /** The grant awaiting confirmation; null keeps the dialog closed. */
  share: ShareWithGroup | null
  onCancel: () => void
  onConfirm: (share: ShareWithGroup) => void
  pending: boolean
}

export function AlertDialogProjectRevokeShare({
  share,
  onCancel,
  onConfirm,
  pending,
}: AlertDialogProjectRevokeShareProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")

  return (
    <AlertDialog
      open={share !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {share && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeTitle", { name: share.group.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeConfirm", { count: share.derivedCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => onConfirm(share)}
            >
              {t("revokeConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}
