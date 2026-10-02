"use client"

// components/forms/projects/share.tsx
// FormProjectShare — grants one group access to a project. Pure: the hosting
// dialog fetches the groups, owns the mutation and decides what a failure says.
// Schema is shared with POST /api/projects/:id/shares (models/projects/types).
// See playbook/forms.md.
//
// Only the *new* grant is a form. Changing the level of a grant that already
// exists is a select that fires immediately, and lives in the dialog.

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
import { SelectProjectAccessOption } from "@/components/selects/projects/access-option"
import { Button } from "@/components/ui/button"
import { PROJECT_ACCESS, type ProjectAccess } from "@/lib/authz/project-access"
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
  /**
   * Resolves when the grant landed. Rejects with an Error whose message is
   * already the user-facing sentence (the dialog maps API failures to
   * translations); the form shows it under the group field.
   */
  onSubmit: (data: ShareProjectInput) => Promise<void>
}

export function FormProjectShare({
  groups,
  onSubmit,
}: FormProjectShareProps) {
  const t = useTranslations("projects.share")

  // How many people a grant reaches, next to the name: a group is chosen for
  // who is in it, and the list never said.
  const groupOption = (g: GroupListItem): string =>
    t("groupOption", { name: g.name, count: g._count.members })

  const form = useForm<ShareProjectInput>({
    resolver: zodResolver(shareProjectSchema),
    // Read is the conservative default: widening a grant is one click on the
    // row that appears, narrowing one already handed out is a conversation.
    defaultValues: { groupId: "", access: PROJECT_ACCESS.READ },
  })

  // Picking a group is the whole gate — `access` always carries a valid value.
  // Disabling until one is chosen keeps the schema as the single validator
  // while sparing the owner a "groupId: invalid uuid" they cannot act on.
  // `useWatch` rather than `form.watch`: the latter returns an unmemoizable
  // function and makes the React Compiler skip this component wholesale.
  const selectedGroupId = useWatch({ control: form.control, name: "groupId" })

  const submit = async (data: ShareProjectInput) => {
    try {
      await onSubmit(data)
    } catch (e) {
      // The rejection is the reason, on the field the owner would change to
      // retry; the selection stays so they can correct it.
      form.setError("groupId", {
        type: "server",
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    // Only on success: the granted group leaves `groups`, so a kept selection
    // would point at a row that has moved to the list below.
    form.reset({ groupId: "", access: data.access })
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
                    {/* Full width of its field, not the primitive's w-fit: a
                        long « name · N membres » must clip, not run under the
                        level select beside it. */}
                    <SelectTrigger className="w-full min-w-0">
                      {/* Base UI renders the raw value unless told how to label
                          it — a bare SelectValue would show the group's uuid. */}
                      <SelectValue className="min-w-0" placeholder={t("groupPlaceholder")}>
                        {(value: string | null) => {
                          const group = groups.find((g) => g.id === value)
                          return group ? groupOption(group) : t("groupPlaceholder")
                        }}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {groupOption(g)}
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
                        {(value: ProjectAccess) => t(`level.${value}`)}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {/* What each level allows, on the option itself. */}
                    <SelectProjectAccessOption access={PROJECT_ACCESS.READ} />
                    <SelectProjectAccessOption access={PROJECT_ACCESS.WRITE} />
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
        {/* Not a FormDescription: that primitive describes one field, and
            this sentence is about the project, not the group or the level. */}
        <p className="mt-2 text-xs text-muted-foreground">{t("ownerNote")}</p>
      </form>
    </Form>
  )
}

