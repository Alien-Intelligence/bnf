"use client"

// components/dialogs/groups/confirm-delete.tsx
// DialogGroupConfirmDelete — deleting a group cascades to its memberships and
// to every share granted through it, so the confirmation names both counts
// rather than asking a bare "are you sure?".

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { useDeleteGroup } from "@/hooks/api/groups"
import type { GroupListItem } from "@/models/groups/schema"

interface DialogGroupConfirmDeleteProps {
  group: GroupListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogGroupConfirmDelete({
  group,
  open,
  onOpenChange,
}: DialogGroupConfirmDeleteProps) {
  const t = useTranslations("groups.delete")
  const tCommon = useTranslations("common")
  const deleteGroup = useDeleteGroup()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  const onConfirm = async () => {
    setError(null)
    try {
      await deleteGroup.mutateAsync(group.id)
      onOpenChange(false)
      toast(t("done", { name: group.name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { name: group.name })}</DialogTitle>
          <DialogDescription>
            {t("description", {
              members: group._count.members,
              shares: group._count.shares,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={deleteGroup.isPending}
          >
            {deleteGroup.isPending ? tCommon("loading") : t("confirm")}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
