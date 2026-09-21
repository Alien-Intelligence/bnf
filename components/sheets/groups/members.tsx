"use client"

// components/sheets/groups/members.tsx
// SheetGroupMembers — the roster for one group: add by email, list, remove.
// Owns the member mutations for the group it is opened on; the hosting client
// owns only which group is selected.

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FormGroupAddMember } from "@/components/forms/groups/add-member"
import { useAddMember, useGroupMembers, useRemoveMember } from "@/hooks/api/groups"
import type { AddMemberInput } from "@/models/groups/types"

interface SheetGroupMembersProps {
  /** The group to show, or null when the sheet is closed. */
  groupId: string | null
  groupName: string
  onOpenChange: (open: boolean) => void
}

export function SheetGroupMembers({
  groupId,
  groupName,
  onOpenChange,
}: SheetGroupMembersProps) {
  const t = useTranslations("groups.members")
  const tCommon = useTranslations("common")

  const { data, isLoading, isError, refetch } = useGroupMembers(groupId)
  // The group id is stable for as long as the sheet is open; "" is only ever
  // reached while closed, when neither mutation can be triggered.
  const addMember = useAddMember(groupId ?? "")
  const removeMember = useRemoveMember(groupId ?? "")

  // Both failures are read off their mutation rather than copied into local
  // state: one sheet instance serves every group, so a second copy would still
  // be on screen after the admin switches from group A to group B.
  const { reset: resetAdd } = addMember
  const { reset: resetRemove } = removeMember
  useEffect(() => {
    // Open/closed is derived from groupId, so this covers reopening too.
    resetAdd()
    resetRemove()
  }, [groupId, resetAdd, resetRemove])

  const onAdd = async (input: AddMemberInput) => {
    // 422 « Aucun compte ne correspond à l'adresse … » — the admin needs the
    // sentence, not a generic failure. mutateAsync stores it on addMember.error,
    // which is handed to the form; catching only keeps the rejection from
    // escaping react-hook-form's handleSubmit.
    await addMember.mutateAsync(input).catch(() => undefined)
  }

  const onRemove = async (userId: string) => {
    // A 403 or 500 here leaves the row exactly where it was; without a message
    // the admin reads that as "the click didn't register" and tries again.
    await removeMember.mutateAsync(userId).catch(() => undefined)
  }

  return (
    <Sheet open={groupId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{groupName}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-6">
          <FormGroupAddMember
            onSubmit={onAdd}
            serverError={addMember.error?.message ?? null}
          />

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{tCommon("error")}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {tCommon("tryAgain")}
              </Button>
            </div>
          ) : !data || data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="space-y-2">
              {removeMember.error && (
                <p className="text-sm text-destructive">
                  {removeMember.error.message}
                </p>
              )}
              <ul className="divide-y rounded-lg border">
                {data.members.map(({ user }) => (
                  <li
                    key={user.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {user.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("remove", { name: user.name })}
                      disabled={removeMember.isPending}
                      onClick={() => onRemove(user.id)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
