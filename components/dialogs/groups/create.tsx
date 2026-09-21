"use client"

// components/dialogs/groups/create.tsx
// DialogGroupCreate — hosts FormGroupCreate and owns the create mutation.
// Rendered at page level (playbook/componentization: conditional dialogs live
// in the client, not nested in content components).

import { useEffect } from "react"
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

  // The failure is read off the mutation rather than copied into local state:
  // the host mounts this dialog persistently, so a second copy of the error
  // would outlive the close and greet the admin on the next open.
  const { reset: resetCreate } = createGroup
  useEffect(() => {
    // playbook/client-patterns: useEffect([open]) owns the reset — onOpenChange
    // never fires for a programmatic open.
    if (open) resetCreate()
  }, [open, resetCreate])

  const onSubmit = async (data: CreateGroupInput) => {
    try {
      const group = await createGroup.mutateAsync(data)
      onOpenChange(false)
      toast(t("created", { name: group.name }))
    } catch {
      // The API answers 409 with the reason (« un groupe portant l'identifiant
      // … existe déjà »). mutateAsync already stored it on createGroup.error,
      // which is rendered below; catching here only stops the rejection from
      // escaping react-hook-form's handleSubmit.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {/* The form owns its react-hook-form state, which the dialog cannot
            reach into; keying it on `open` remounts it on every open so a name
            abandoned mid-typing is not still sitting there next time. */}
        <FormGroupCreate
          key={String(open)}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          submitLabel={t("submit")}
        />
        {createGroup.error && (
          <p className="text-sm text-destructive">{createGroup.error.message}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
