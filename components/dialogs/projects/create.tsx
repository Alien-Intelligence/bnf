"use client"

// components/dialogs/projects/create.tsx
// DialogProjectCreate — hosts FormProjectCreate, owns the create mutation, and
// navigates to the new project's Constituer step on success. Rendered at page
// level (playbook/componentization: conditional dialogs live in the client, not
// nested in content components).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "@/i18n/navigation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormProjectCreate } from "@/components/forms/projects/create"
import { useToast } from "@/components/ui/toast"
import { useCreateProject } from "@/hooks/api/projects"
import { ROUTES } from "@/lib/constants"
import type { CreateProjectRequest } from "@/models/projects/types"

interface DialogProjectCreateProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogProjectCreate({
  open,
  onOpenChange,
}: DialogProjectCreateProps) {
  const t = useTranslations("projects.form")
  const tCommon = useTranslations("common")
  const router = useRouter()
  const createProject = useCreateProject()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (data: CreateProjectRequest) => {
    setError(null)
    try {
      const project = await createProject.mutateAsync(data)
      onOpenChange(false)
      toast(t("created", { name: project.name }))
      router.push(ROUTES.constituer(project.id))
    } catch {
      setError(tCommon("error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <FormProjectCreate
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
