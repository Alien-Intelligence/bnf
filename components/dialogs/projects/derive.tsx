"use client"

// components/dialogs/projects/derive.tsx
// DialogProjectDerive — « Créer un espace de recherche sur ce corpus ». Hosts
// FormProjectDerive, owns the create mutation, and navigates into the new
// workspace's Rechercher step (the only step it has).

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
import { FormProjectDerive } from "@/components/forms/projects/derive"
import { useToast } from "@/components/ui/toast"
import { useCreateDerivedProject } from "@/hooks/api/projects"
import { ROUTES } from "@/lib/constants"
import type { ProjectListItem } from "@/models/projects/schema"

interface DialogProjectDeriveProps {
  source: ProjectListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogProjectDerive({
  source,
  open,
  onOpenChange,
}: DialogProjectDeriveProps) {
  const t = useTranslations("projects.derive")
  const tCommon = useTranslations("common")
  const router = useRouter()
  const createDerived = useCreateDerivedProject()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (data: { name: string; subtitle?: string }) => {
    setError(null)
    try {
      const project = await createDerived.mutateAsync({
        sourceProjectId: source.id,
        name: data.name,
        subtitle: data.subtitle,
      })
      onOpenChange(false)
      toast(t("created", { name: project.name }))
      router.push(ROUTES.rechercher(project.id))
    } catch (e) {
      // 422 names the reason — no grant, never ingested, already derived.
      setError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { source: source.name, owner: source.ownerName })}
          </DialogDescription>
        </DialogHeader>
        <FormProjectDerive
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          defaultName={t("defaultName", { source: source.name })}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
