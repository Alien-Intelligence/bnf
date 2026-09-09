"use client"

// components/forms/groups/create.tsx
// FormGroupCreate — the new-group form. Pure: it owns no API calls and no
// open/close state; the hosting dialog passes onSubmit. Schema is shared with
// POST /api/groups (models/groups/types). See playbook/forms.md.

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
import { createGroupSchema, type CreateGroupInput } from "@/models/groups/types"

interface FormGroupCreateProps {
  onSubmit: (data: CreateGroupInput) => Promise<void>
  onCancel: () => void
  defaultValues?: Partial<CreateGroupInput>
  submitLabel: string
}

export function FormGroupCreate({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
}: FormGroupCreateProps) {
  const t = useTranslations("groups.form")
  const tCommon = useTranslations("common")

  const form = useForm<CreateGroupInput>({
    resolver: zodResolver(createGroupSchema),
    defaultValues: { name: "", ...defaultValues },
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
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? tCommon("loading") : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  )
}
