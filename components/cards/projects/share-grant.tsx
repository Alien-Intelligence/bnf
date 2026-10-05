"use client"

// components/cards/projects/share-grant.tsx
// CardProjectShareGrant — one grant in the share dialog: the group, how many
// people it reaches, what revoking it costs, and the two controls that change
// it. A grant whose stored level is not one this app knows grants nothing
// (lib/authz/project-access.ts) and is shown as such, with only « revoke ».
//
// The level is editable in place rather than through revoke-then-re-share:
// there is one row per (project, group), so changing the level is an update —
// and making the owner revoke first would sever every workspace derived from
// that grant to express what the model treats as a single field changing.

import { Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SelectProjectAccess } from "@/components/selects/projects/access"
import { isProjectAccess, type ProjectAccess } from "@/lib/authz/project-access"
import type { ShareWithGroup } from "@/models/projects/schema"

interface CardProjectShareGrantProps {
  share: ShareWithGroup
  onChangeAccess: (share: ShareWithGroup, access: ProjectAccess) => void
  /** Revoke, or ask first when derived workspaces depend on it (the dialog decides). */
  onRevoke: (share: ShareWithGroup) => void
  /** This grant is being changed or revoked right now. */
  busy: boolean
}

export function CardProjectShareGrant({
  share,
  onChangeAccess,
  onRevoke,
  busy,
}: CardProjectShareGrantProps) {
  const t = useTranslations("projects.share")
  const access = share.access

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="truncate text-sm">{share.group.name}</CardTitle>
        <CardDescription className="text-xs">
          {t("memberCount", { count: share.group._count.members })}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {isProjectAccess(access) && (
            <SelectProjectAccess
              value={access}
              onValueChange={(next) => onChangeAccess(share, next)}
              disabled={busy}
              size="sm"
              className="w-36"
              aria-label={t("changeAccess", { name: share.group.name })}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={t("revoke", { name: share.group.name })}
            onClick={() => onRevoke(share)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </CardAction>
      </CardHeader>
      {(!isProjectAccess(access) || share.derivedCount > 0) && (
        <CardContent className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {!isProjectAccess(access) && <p>{t("levelUnknown")}</p>}
          {/* Revoking costs these workspaces their corpus — say so before the
              owner clicks, not after. */}
          {share.derivedCount > 0 && <p>{t("derived", { count: share.derivedCount })}</p>}
        </CardContent>
      )}
    </Card>
  )
}
