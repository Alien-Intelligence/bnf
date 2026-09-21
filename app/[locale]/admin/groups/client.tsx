"use client"

// app/[locale]/admin/groups/client.tsx
// Admin console — Groups tab. Groups are the unit a project is shared with:
// an admin creates them and manages membership; project owners then share into
// them from their own project. Header/tabs/main wrapper come from the admin
// layout; the listing and its loading / error / empty / data branches come from
// LayoutGroupsTable. This client owns only the heading and which modal is open.

import { useState } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useGroups } from "@/hooks/api/groups"
import { Button } from "@/components/ui/button"
import { LayoutGroupsTable } from "@/components/layouts/groups/table"
import { DialogGroupCreate } from "@/components/dialogs/groups/create"
import { DialogGroupRename } from "@/components/dialogs/groups/rename"
import { DialogGroupConfirmDelete } from "@/components/dialogs/groups/confirm-delete"
import { SheetGroupMembers } from "@/components/sheets/groups/members"
import type { GroupListItem } from "@/models/groups/schema"

interface AdminGroupsClientProps {
  initialGroups: GroupListItem[]
}

export function AdminGroupsClient({ initialGroups }: AdminGroupsClientProps) {
  const t = useTranslations("groups")

  const { data: groups, isLoading, isError, refetch } = useGroups({
    initialData: initialGroups,
  })

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

      <LayoutGroupsTable
        groups={groups}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        onCreate={() => setCreateOpen(true)}
        onOpenMembers={setMembersOf}
        onRename={setRenaming}
        onDelete={setDeleting}
      />

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
