"use client"

// components/forms/projects/create.tsx
// FormProjectCreate — the new-project form. Pure: it owns no API calls and no
// open/close state; the hosting dialog passes onSubmit and reacts to success.
// Schema is shared with POST /api/projects (models/projects/types). See
// playbook/forms.md.

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  createProjectRequestSchema,
  type CreateProjectRequest,
} from "@/models/projects/types"

interface FormProjectCreateProps {
  onSubmit: (data: CreateProjectRequest) => Promise<void>
  onCancel: () => void
  defaultValues?: Partial<CreateProjectRequest>
}

export function FormProjectCreate({
  onSubmit,
  onCancel,
  defaultValues,
}: FormProjectCreateProps) {
  const t = useTranslations("projects.form")
  const tCommon = useTranslations("common")

  const form = useForm<CreateProjectRequest>({
    resolver: zodResolver(createProjectRequestSchema),
    defaultValues: { name: "", subtitle: "", ...defaultValues },
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("name")}</FormLabel>
              <FormControl>
                <Input placeholder={t("namePlaceholder")} autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="subtitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("subtitle")}</FormLabel>
              <FormControl>
                <Input
                  placeholder={t("subtitlePlaceholder")}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? tCommon("loading") : t("submit")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
