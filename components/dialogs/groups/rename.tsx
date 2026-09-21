"use client"

// components/dialogs/groups/rename.tsx
// DialogGroupRename — reuses FormGroupCreate (same single-field shape) and owns
// the rename mutation for one group.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormGroupCreate } from "@/components/forms/groups/create"
import { useToast } from "@/components/ui/toast"
import { useRenameGroup } from "@/hooks/api/groups"
import type { GroupListItem } from "@/models/groups/schema"
import type { CreateGroupInput } from "@/models/groups/types"

interface DialogGroupRenameProps {
  group: GroupListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogGroupRename({
  group,
  open,
  onOpenChange,
}: DialogGroupRenameProps) {
  const t = useTranslations("groups.form")
  const renameGroup = useRenameGroup(group.id)
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (data: CreateGroupInput) => {
    setError(null)
    try {
      const renamed = await renameGroup.mutateAsync(data)
      onOpenChange(false)
      toast(t("renamed", { name: renamed.name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
          <DialogDescription>{t("renameDescription")}</DialogDescription>
        </DialogHeader>
        <FormGroupCreate
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          defaultValues={{ name: group.name }}
          submitLabel={t("renameSubmit")}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
