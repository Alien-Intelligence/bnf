"use client"

// components/cards/groups/row.tsx
// CardGroupRow — one group in the admin Groups table: name, slug, member and
// share counts, and the three actions. Pure presentation: the hosting client
// owns which dialog or sheet is open.

import { useTranslations } from "next-intl"
import { Pencil, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GroupListItem } from "@/models/groups/schema"

interface CardGroupRowProps {
  group: GroupListItem
  onOpenMembers: () => void
  onRename: () => void
  onDelete: () => void
}

export function CardGroupRow({
  group,
  onOpenMembers,
  onRename,
  onDelete,
}: CardGroupRowProps) {
  const t = useTranslations("groups.row")

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{group.name}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {group.slug}
        </div>
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {group._count.members}
      </td>
      <td className="px-4 py-3 text-right font-mono">{group._count.shares}</td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" onClick={onOpenMembers}>
            <Users className="size-3.5" />
            {t("members")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRename}
            aria-label={t("rename")}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-label={t("delete")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  )
}
