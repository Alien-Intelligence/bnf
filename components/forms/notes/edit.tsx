"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"
import { updateNoteSchema, type UpdateNoteInput } from "@/models/notes/types"
import type { NoteWithCitations } from "@/models/notes/schema"

interface FormNoteEditProps {
  note: NoteWithCitations
  onCancel: () => void
  onSaved: () => void
  onSubmit: (data: UpdateNoteInput) => Promise<void>
  isError?: boolean
}

export function FormNoteEdit({
  note,
  onCancel,
  onSaved: _onSaved,
  onSubmit,
  isError = false,
}: FormNoteEditProps) {
  const t = useTranslations("notes.edit")
  const tCommon = useTranslations("common")

  const form = useForm<UpdateNoteInput>({
    resolver: zodResolver(updateNoteSchema),
    defaultValues: {
      title: note.title,
      bodyMd: note.body_md ?? "",
    },
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 p-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("titleLabel")}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="bodyMd"
          render={({ field }) => (
            <FormItem className="flex flex-col flex-1">
              <FormLabel>{t("bodyLabel")}</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  className="font-mono text-sm min-h-[320px] resize-none"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {isError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{tCommon("error")}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
