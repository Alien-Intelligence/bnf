"use client"

// components/dialogs/feedback/feedback-dialog.tsx
// Shared feedback dialog reused by all three placements (session / note / turn).
// Collects a 3-way rating (bad/ok/great) + an optional comment and submits via
// useSubmitFeedback. target + targetId come from props; the form owns only the
// rating + comment. No new shadcn primitive — the rating selector is three
// plain Buttons (playbook/new-primitives.md).

import { useEffect } from "react"
import { useForm, Controller } from "react-hook-form"
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
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useSubmitFeedback } from "@/hooks/api/feedback"
import { FEEDBACK_RATING, type FeedbackRating, type FeedbackTarget } from "@/models/feedback/schema"

const RATINGS: FeedbackRating[] = [
  FEEDBACK_RATING.BAD,
  FEEDBACK_RATING.OK,
  FEEDBACK_RATING.GREAT,
]

// Form-local schema: the dialog owns only rating + comment. target/targetId are
// supplied by props and merged at submit (mirrors DialogNewNote's subset schema).
const formSchema = z.object({
  rating: z.enum(["bad", "ok", "great"]),
  comment: z.string().trim().max(2_000).optional(),
})
type FormValues = z.infer<typeof formSchema>

interface FeedbackDialogProps {
  projectId: string
  target: FeedbackTarget
  targetId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Existing rating/comment when editing — prefills the form. */
  initialRating?: FeedbackRating
  initialComment?: string | null
}

export function FeedbackDialog({
  projectId,
  target,
  targetId,
  open,
  onOpenChange,
  initialRating,
  initialComment,
}: FeedbackDialogProps) {
  const t = useTranslations("feedback")
  const { toast } = useToast()
  const submit = useSubmitFeedback(projectId)
  const isEditing = initialRating != null

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { comment: "" },
  })

  // Sync the form to the target's existing feedback each time the dialog opens
  // (the same dialog instance is reused across targets via the button).
  useEffect(() => {
    if (open) {
      form.reset({
        ...(initialRating ? { rating: initialRating } : {}),
        comment: initialComment ?? "",
      })
    }
  }, [open, initialRating, initialComment, form])

  const onSubmit = async (values: FormValues) => {
    try {
      await submit.mutateAsync({
        target,
        targetId,
        rating: values.rating,
        comment: values.comment?.trim() ? values.comment.trim() : undefined,
      })
      form.reset({ comment: "" })
      onOpenChange(false)
      toast(t("success"))
    } catch {
      toast(t("error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t("editTitle") : t("dialogTitle")}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="rating"
              render={() => (
                <FormItem>
                  <FormLabel>{t("ratingLabel")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="rating"
                      render={({ field }) => (
                        <div className="flex gap-2">
                          {RATINGS.map((r) => (
                            <Button
                              key={r}
                              type="button"
                              variant={field.value === r ? "default" : "outline"}
                              size="sm"
                              onClick={() => field.onChange(r)}
                              className={cn("flex-1")}
                            >
                              {t(`rating.${r}`)}
                            </Button>
                          ))}
                        </div>
                      )}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("commentLabel")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("commentPlaceholder")}
                      rows={3}
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
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={submit.isPending}>
                {submit.isPending ? t("submitting") : t("submit")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
