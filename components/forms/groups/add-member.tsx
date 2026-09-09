"use client"

// components/forms/groups/add-member.tsx
// FormGroupAddMember — the add-by-email field in the members sheet. Pure: the
// hosting sheet owns the mutation. Schema shared with
// POST /api/groups/:gid/members. See playbook/forms.md.

import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { UserPlus } from "lucide-react"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { addMemberSchema, type AddMemberInput } from "@/models/groups/types"

interface FormGroupAddMemberProps {
  onSubmit: (data: AddMemberInput) => Promise<void>
  /** Server-side rejection (unknown address), shown under the field. */
  serverError: string | null
}

export function FormGroupAddMember({
  onSubmit,
  serverError,
}: FormGroupAddMemberProps) {
  const t = useTranslations("groups.members")
  const form = useForm<AddMemberInput>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: "" },
  })

  const { setError } = form
  useEffect(() => {
    // The server is the only place that knows whether an address resolves to an
    // account, so its rejection is surfaced on the field that caused it.
    if (serverError) setError("email", { type: "server", message: serverError })
  }, [serverError, setError])

  const submit = async (data: AddMemberInput) => {
    await onSubmit(data)
    form.reset({ email: "" })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-2">
        <div className="flex items-start gap-2">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormControl>
                  <Input
                    type="email"
                    placeholder={t("emailPlaceholder")}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            <UserPlus className="size-4" />
            {t("add")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
