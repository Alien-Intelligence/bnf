"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
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
import { useCreateNote } from "@/hooks/api/notes"
import { useTranslations } from "next-intl"

const schema = z.object({
  title: z.string().min(1).max(200),
})

type FormValues = z.infer<typeof schema>

interface DialogNewNoteProps {
  projectId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (noteId: string) => void
}

export function DialogNewNote({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: DialogNewNoteProps) {
  const t = useTranslations("research.note")
  const createNote = useCreateNote(projectId)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "" },
  })

  const onSubmit = async (values: FormValues) => {
    const note = await createNote.mutateAsync({
      title: values.title,
      bodyMd: "",
    })
    form.reset()
    onOpenChange(false)
    onCreated(note.id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("create")}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("titlePlaceholder")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("titlePlaceholder")}
                      autoFocus
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={createNote.isPending}>
                {createNote.isPending ? "Création…" : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
