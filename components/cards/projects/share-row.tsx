"use client"

// components/cards/projects/share-row.tsx
// One live grant in the share dialog: the group, what it costs to revoke, and
// the two controls that change it.
//
// The level is editable in place rather than through revoke-then-re-share.
// There is one row per (project, group), so changing the level is an update —
// and making the owner revoke first would sever every workspace derived from
// that grant to express what the model treats as a single field changing.

import { Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { SelectProjectAccess } from "@/components/selects/projects/access"
import type { ShareWithGroup } from "@/models/projects/schema"

interface CardProjectShareRowProps {
  share: ShareWithGroup
  onChangeAccess: (groupId: string, value: string | null) => void
  onRevoke: (groupId: string) => void
  /** True while a revoke is in flight. */
  revoking?: boolean
}

export function CardProjectShareRow({
  share,
  onChangeAccess,
  onRevoke,
  revoking,
}: CardProjectShareRowProps) {
  const t = useTranslations("projects.share")

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{share.group.name}</div>
        {/* Revoking costs these workspaces their corpus — say so before the
            owner clicks, not after. */}
        {share.derivedCount > 0 && (
          <div className="text-xs text-muted-foreground">
            {t("derived", { count: share.derivedCount })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <SelectProjectAccess
          value={share.access}
          onValueChange={(v) => onChangeAccess(share.groupId, v)}
          groupName={share.group.name}
        />

        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          aria-label={t("revoke", { name: share.group.name })}
          onClick={() => onRevoke(share.groupId)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  )
}
