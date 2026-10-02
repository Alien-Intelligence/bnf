"use client"

// components/forms/projects/share.tsx
// FormProjectShare — grants one group access to a project. Pure: the hosting
// dialog fetches the groups, owns the mutation and classifies a failure; the
// form shows it, translated, on the group field. The schema is the route's
// (models/projects/types shareProjectSchema), with the "choose a group"
// message supplied in the user's language (shareProjectFormSchema).
// See playbook/forms.md.
//
// Only the *new* grant is a form. Changing the level of a grant that already
// exists is a select that fires immediately, on the grant's row.

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Button } from "@/components/ui/button"
import { SelectProjectAccess } from "@/components/selects/projects/access"
import { SelectProjectShareGroup } from "@/components/selects/projects/share-group"
import { ApiError } from "@/lib/api-fetch"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import {
  shareProjectFormSchema,
  shareProjectSchema,
  type ShareProjectFormValues,
  type ShareProjectInput,
} from "@/models/projects/types"
import type { GroupListItem } from "@/models/groups/schema"

/** Why a share request failed, as the user is told (projects.share.errors.*). */
export const SHARE_ERROR_REASON = {
  FORBIDDEN: "forbidden",
  PROJECT_GONE: "projectGone",
  GROUP_GONE: "groupGone",
  GENERIC: "generic",
} as const
export type ShareErrorReason = (typeof SHARE_ERROR_REASON)[keyof typeof SHARE_ERROR_REASON]

/** Classifies a failed share request; the original error stays the `cause`. */
export function shareErrorReason(error: unknown): ShareErrorReason {
  if (error instanceof ApiError) {
    if (error.status === 403) return SHARE_ERROR_REASON.FORBIDDEN
    if (error.status === 404) return SHARE_ERROR_REASON.PROJECT_GONE
    if (error.status === 422) return SHARE_ERROR_REASON.GROUP_GONE
  }
  return SHARE_ERROR_REASON.GENERIC
}

/** A grant the server refused, classified; FormProjectShare shows `reason`. */
export class ShareGrantError extends Error {
  constructor(
    readonly reason: ShareErrorReason,
    options: { cause: unknown },
  ) {
    super(`Share grant failed: ${reason}`, options)
    this.name = "ShareGrantError"
  }
}

interface FormProjectShareProps {
  /**
   * The groups still grantable. The dialog filters out those already holding a
   * grant: the (project, group) pair is unique, so a second grant would be an
   * update, and that is what the existing row's own select is for.
   */
  groups: GroupListItem[]
  /** Resolves when the grant landed; rejects with a ShareGrantError. */
  onSubmit: (data: ShareProjectInput) => Promise<void>
}

export function FormProjectShare({ groups, onSubmit }: FormProjectShareProps) {
  const t = useTranslations("projects.share")

  const form = useForm<ShareProjectFormValues>({
    resolver: zodResolver(shareProjectFormSchema({ groupRequired: t("errors.groupRequired") })),
    // Read is the conservative default: widening a grant is one click on the
    // row that appears, narrowing one already handed out is a conversation.
    defaultValues: { groupId: null, access: PROJECT_ACCESS.READ },
  })

  const submit = async (values: ShareProjectFormValues) => {
    // The resolver has already validated these with the same rules; this is
    // the narrowing to the route's input type (a chosen group), not a second
    // opinion.
    const data = shareProjectSchema.parse(values)
    try {
      await onSubmit(data)
    } catch (e) {
      // The reason, translated, on the field the owner would change to retry;
      // the selection stays so they can correct it. Anything that is not a
      // classified refusal says the generic sentence — never raw text.
      const reason = e instanceof ShareGrantError ? e.reason : SHARE_ERROR_REASON.GENERIC
      form.setError("groupId", { type: "server", message: t(`errors.${reason}`) })
      return
    }
    // Only on success: the granted group leaves `groups`, so a kept selection
    // would point at a row that has moved to the list below.
    form.reset({ groupId: null, access: data.access })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <div className="flex flex-wrap items-end gap-2">
          <FormField
            control={form.control}
            name="groupId"
            render={({ field }) => (
              <FormItem className="min-w-40 flex-1 space-y-1.5">
                <FormLabel>{t("group")}</FormLabel>
                <FormControl>
                  <SelectProjectShareGroup
                    groups={groups}
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="access"
            render={({ field }) => (
              <FormItem className="w-36 space-y-1.5">
                <FormLabel>{t("access")}</FormLabel>
                <FormControl>
                  <SelectProjectAccess value={field.value} onValueChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="size-4 animate-spin" />}
            {t("grant")}
          </Button>
        </div>
        {/* Not a FormDescription: that primitive describes one field, and
            this sentence is about the project, not the group or the level. */}
        <p className="mt-2 text-xs text-muted-foreground">{t("ownerNote")}</p>
      </form>
    </Form>
  )
}
