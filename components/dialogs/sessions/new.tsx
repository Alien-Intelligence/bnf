"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useCreateSession } from "@/hooks/api/sessions"
import { createSessionSchema, type CreateSessionInput } from "@/models/sessions/types"
import type { AppSession } from "@/models/sessions/schema"

interface DialogNewSessionProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  scope: "corpus" | "research"
  onCreated: (session: AppSession) => void
}

export function DialogNewSession({
  open,
  onOpenChange,
  projectId,
  scope,
  onCreated,
}: DialogNewSessionProps) {
  const t = useTranslations("sessions.new")
  const tCommon = useTranslations("common")
  const create = useCreateSession(projectId)

  const form = useForm<CreateSessionInput>({
    resolver: zodResolver(createSessionSchema),
    defaultValues: { scope, title: "" },
  })

  const onSubmit = form.handleSubmit(async (data) => {
    const session = await create.mutateAsync(data)
    form.reset()
    onCreated(session)
    onOpenChange(false)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="session-title">{t("titleLabel")}</Label>
            <Input
              id="session-title"
              autoFocus
              disabled={create.isPending}
              {...form.register("title")}
            />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">
                {form.formState.errors.title.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={() => {
                form.reset()
                onOpenChange(false)
              }}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
