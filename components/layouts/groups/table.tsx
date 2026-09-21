"use client"

// components/layouts/groups/table.tsx
// LayoutGroupsTable — the admin Groups listing: the card, the table shell and
// the four UI states. Branches over loading / error / empty / content in
// explicit if-blocks per playbook/ui-states.md. The hosting client owns which
// dialog or sheet is open; this component only reports the intent.

import { Plus, Users } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CardGroupRow } from "@/components/cards/groups/row"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import type { GroupListItem } from "@/models/groups/schema"

interface LayoutGroupsTableProps {
  groups?: GroupListItem[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  /** Offered from the empty state, so a fresh install has a way forward. */
  onCreate: () => void
  onOpenMembers: (group: GroupListItem) => void
  onRename: (group: GroupListItem) => void
  onDelete: (group: GroupListItem) => void
}

export function LayoutGroupsTable({
  groups,
  isLoading,
  isError,
  onRetry,
  onCreate,
  onOpenMembers,
  onRename,
  onDelete,
}: LayoutGroupsTableProps) {
  const t = useTranslations("groups")
  const tCol = useTranslations("groups.col")
  const tCommon = useTranslations("common")

  // Loading — mirror the table rows so the card does not resize under the
  // admin when the real rows land.
  if (isLoading) {
    return (
      <Card>
        <CardContent className="px-0">
          <div className="flex flex-col gap-3 px-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-8 w-32" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  // Error — visible, retriable, never silent.
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-destructive">{tCommon("error")}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  // Empty — no group exists yet; sharing is impossible until one does.
  if (!groups || groups.length === 0) {
    return (
      <LayoutSharedEmptyState
        icon={Users}
        title={t("empty")}
        description={t("emptyHint")}
        action={
          <Button onClick={onCreate}>
            <Plus className="size-4" />
            {t("new")}
          </Button>
        }
      />
    )
  }

  return (
    <Card>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">{tCol("name")}</th>
              <th className="px-4 py-2 text-right font-medium">
                {tCol("members")}
              </th>
              <th className="px-4 py-2 text-right font-medium">
                {tCol("shares")}
              </th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <CardGroupRow
                key={group.id}
                group={group}
                onOpenMembers={() => onOpenMembers(group)}
                onRename={() => onRename(group)}
                onDelete={() => onDelete(group)}
              />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
