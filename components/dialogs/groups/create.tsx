"use client"

// components/dialogs/groups/create.tsx
// DialogGroupCreate — hosts FormGroupCreate and owns the create mutation.
// Rendered at page level (playbook/componentization: conditional dialogs live
// in the client, not nested in content components).

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
import { useCreateGroup } from "@/hooks/api/groups"
import type { CreateGroupInput } from "@/models/groups/types"

interface DialogGroupCreateProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogGroupCreate({
  open,
  onOpenChange,
}: DialogGroupCreateProps) {
  const t = useTranslations("groups.form")
  const createGroup = useCreateGroup()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (data: CreateGroupInput) => {
    setError(null)
    try {
      const group = await createGroup.mutateAsync(data)
      onOpenChange(false)
      toast(t("created", { name: group.name }))
    } catch (e) {
      // The API answers 409 with the reason (« un groupe portant l'identifiant
      // … existe déjà »); showing it is the whole point of surfacing it.
      setError(e instanceof Error ? e.message : null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <FormGroupCreate
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          submitLabel={t("submit")}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
