"use client"

// components/forms/projects/share.tsx
// FormProjectShare — grants one group access to a project. Pure: the hosting
// dialog fetches the groups, owns the mutation and decides what a failure says.
// Schema is shared with POST /api/projects/:id/shares (models/projects/types).
// See playbook/forms.md.
//
// Only the *new* grant is a form. Changing the level of a grant that already
// exists is a select that fires immediately, and lives in the dialog.

import { useEffect } from "react"
import { useForm, useWatch } from "react-hook-form"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import {
  shareProjectSchema,
  type ShareProjectInput,
} from "@/models/projects/types"
import type { GroupListItem } from "@/models/groups/schema"

interface FormProjectShareProps {
  /**
   * The groups still grantable. The dialog filters out those already holding a
   * grant: the (project, group) pair is unique, so a second grant would be an
   * update, and that is what the existing row's own select is for.
   */
  groups: GroupListItem[]
  /** Resolves true when the grant landed, false when the server refused. */
  onSubmit: (data: ShareProjectInput) => Promise<boolean>
  /** Server-side rejection (422 names the reason), shown under the group field. */
  serverError: string | null
}

export function FormProjectShare({
  groups,
  onSubmit,
  serverError,
}: FormProjectShareProps) {
  const t = useTranslations("projects.share")

  const form = useForm<ShareProjectInput>({
    resolver: zodResolver(shareProjectSchema),
    // Read is the conservative default: widening a grant is one click on the
    // row that appears, narrowing one already handed out is a conversation.
    defaultValues: { groupId: "", access: PROJECT_ACCESS.READ },
  })

  const { setError } = form
  useEffect(() => {
    // The server is the only place that knows whether the grant is allowed, so
    // its rejection is surfaced on the field the owner would change to retry.
    if (serverError) {
      setError("groupId", { type: "server", message: serverError })
    }
  }, [serverError, setError])

  // Picking a group is the whole gate — `access` always carries a valid value.
  // Disabling until one is chosen keeps the schema as the single validator
  // while sparing the owner a "groupId: invalid uuid" they cannot act on.
  // `useWatch` rather than `form.watch`: the latter returns an unmemoizable
  // function and makes the React Compiler skip this component wholesale.
  const selectedGroupId = useWatch({ control: form.control, name: "groupId" })

  const submit = async (data: ShareProjectInput) => {
    // Only on success: the granted group leaves `groups`, so a kept selection
    // would point at a row that has moved to the list below. After a refusal
    // the selection is exactly what the owner wants to correct and retry.
    if (await onSubmit(data)) {
      form.reset({ groupId: "", access: data.access })
    }
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
                <Select
                  value={field.value}
                  onValueChange={(v) => field.onChange(v ?? "")}
                >
                  <FormControl>
                    <SelectTrigger>
                      {/* Base UI renders the raw value unless told how to label
                          it — a bare SelectValue would show the group's uuid. */}
                      <SelectValue placeholder={t("groupPlaceholder")}>
                        {(value: string | null) =>
                          groups.find((g) => g.id === value)?.name ??
                          t("groupPlaceholder")
                        }
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue>
                        {(value: string | null) =>
                          value === PROJECT_ACCESS.WRITE
                            ? t("level.write")
                            : t("level.read")
                        }
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={PROJECT_ACCESS.READ}>
                      {t("level.read")}
                    </SelectItem>
                    <SelectItem value={PROJECT_ACCESS.WRITE}>
                      {t("level.write")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button
            type="submit"
            disabled={!selectedGroupId || form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {t("grant")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
