"use client"

// components/sheets/groups/members.tsx
// SheetGroupMembers — the roster for one group: add by email, list, remove.
// Owns the member mutations for the group it is opened on; the hosting client
// owns only which group is selected.

import { useState } from "react"
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
  const [addError, setAddError] = useState<string | null>(null)

  const { data, isLoading, isError, refetch } = useGroupMembers(groupId)
  // The group id is stable for as long as the sheet is open; "" is only ever
  // reached while closed, when neither mutation can be triggered.
  const addMember = useAddMember(groupId ?? "")
  const removeMember = useRemoveMember(groupId ?? "")

  const onAdd = async (input: AddMemberInput) => {
    setAddError(null)
    try {
      await addMember.mutateAsync(input)
    } catch (e) {
      // 422 « Aucun compte ne correspond à l'adresse … » — the admin needs the
      // sentence, not a generic failure.
      setAddError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  return (
    <Sheet open={groupId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{groupName}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-6">
          <FormGroupAddMember onSubmit={onAdd} serverError={addError} />

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
                    onClick={() => removeMember.mutate(user.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
