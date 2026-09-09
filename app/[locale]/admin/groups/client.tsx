"use client"

// app/[locale]/admin/groups/client.tsx
// Admin console — Groups tab. Groups are the unit a project is shared with:
// an admin creates them and manages membership; project owners then share into
// them from their own project. Header/tabs/main wrapper come from the admin
// layout. Loading / error / empty / data are distinct branches.

import { useState } from "react"
import { Plus, Users } from "lucide-react"
import { useTranslations } from "next-intl"
import { useGroups } from "@/hooks/api/groups"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { CardGroupRow } from "@/components/cards/groups/row"
import { DialogGroupCreate } from "@/components/dialogs/groups/create"
import { DialogGroupRename } from "@/components/dialogs/groups/rename"
import { DialogGroupConfirmDelete } from "@/components/dialogs/groups/confirm-delete"
import { SheetGroupMembers } from "@/components/sheets/groups/members"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import type { GroupListItem } from "@/models/groups/schema"

export function AdminGroupsClient() {
  const t = useTranslations("groups")
  const tCommon = useTranslations("common")

  const { data: groups, isLoading, isError, refetch } = useGroups()

  const [createOpen, setCreateOpen] = useState(false)
  const [membersOf, setMembersOf] = useState<GroupListItem | null>(null)
  const [renaming, setRenaming] = useState<GroupListItem | null>(null)
  const [deleting, setDeleting] = useState<GroupListItem | null>(null)

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <span className="mono-eyebrow">{t("eyebrow")}</span>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t("new")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">{tCommon("error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {tCommon("tryAgain")}
          </Button>
        </div>
      ) : !groups || groups.length === 0 ? (
        <LayoutSharedEmptyState
          icon={Users}
          title={t("empty")}
          description={t("emptyHint")}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t("new")}
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t("col.name")}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("col.members")}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("col.shares")}
                  </th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <CardGroupRow
                    key={group.id}
                    group={group}
                    onOpenMembers={() => setMembersOf(group)}
                    onRename={() => setRenaming(group)}
                    onDelete={() => setDeleting(group)}
                  />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <DialogGroupCreate open={createOpen} onOpenChange={setCreateOpen} />

      <SheetGroupMembers
        groupId={membersOf?.id ?? null}
        groupName={membersOf?.name ?? ""}
        onOpenChange={(open) => {
          if (!open) setMembersOf(null)
        }}
      />

      {renaming && (
        <DialogGroupRename
          group={renaming}
          open
          onOpenChange={(open) => {
            if (!open) setRenaming(null)
          }}
        />
      )}

      {deleting && (
        <DialogGroupConfirmDelete
          group={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
