"use client"

// components/forms/projects/derive.tsx
// FormProjectDerive — names the new research workspace built over a shared
// corpus. Pure: the hosting dialog owns the mutation. The source project is not
// a form field — it is fixed by where the dialog was opened from, and the
// server resolves the grant behind it. See playbook/forms.md.

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { z } from "zod"
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
import { createDerivedProjectSchema } from "@/models/projects/types"

// The source id is supplied by the dialog, not typed by the user.
const formSchema = createDerivedProjectSchema.omit({ sourceProjectId: true })
type FormValues = z.infer<typeof formSchema>

interface FormProjectDeriveProps {
  onSubmit: (data: FormValues) => Promise<void>
  onCancel: () => void
  defaultName: string
}

export function FormProjectDerive({
  onSubmit,
  onCancel,
  defaultName,
}: FormProjectDeriveProps) {
  const t = useTranslations("projects.derive")
  const tCommon = useTranslations("common")

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: defaultName, subtitle: "" },
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
                <Input autoFocus {...field} />
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
