"use client"

// components/cards/projects/share-grants.tsx
// CardProjectShareGrants — « Groupes ayant accès (n) » in the share dialog:
// loading → error → empty → one row per grant, each with its reach, what
// revoking it costs, and the two controls that change it.
//
// The level is editable in place rather than through revoke-then-re-share.
// There is one row per (project, group), so changing the level is an update —
// and making the owner revoke first would sever every workspace derived from
// that grant to express what the model treats as a single field changing.

import type { UseQueryResult } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { SelectProjectAccess } from "@/components/selects/projects/access"
import type { ProjectAccess } from "@/lib/authz/project-access"
import type { ShareWithGroup } from "@/models/projects/schema"
import { shareProjectSchema } from "@/models/projects/types"

/** Placeholder rows while the grants load. */
const GRANTS_SKELETON_ROWS = 2

interface CardProjectShareGrantsProps {
  grants: UseQueryResult<ShareWithGroup[]>
  onChangeAccess: (share: ShareWithGroup, access: ProjectAccess) => void
  /** Revoke, or ask first when derived workspaces depend on it (the dialog decides). */
  onRevoke: (share: ShareWithGroup) => void
  /** The group whose grant is being changed or revoked right now, if any. */
  busyGroupId: string | null
}

export function CardProjectShareGrants(props: CardProjectShareGrantsProps) {
  const t = useTranslations("projects.share")
  const { grants } = props
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          {/* Counted only once known: « (0) » while loading would be a lie. */}
          {grants.data
            ? t("currentHeading", { count: grants.data.length })
            : t("currentHeadingUnknown")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <GrantsBody {...props} />
      </CardContent>
    </Card>
  )
}

function GrantsBody({ grants, onChangeAccess, onRevoke, busyGroupId }: CardProjectShareGrantsProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")

  if (grants.isPending) {
    return (
      <ul className="flex flex-col gap-3" aria-busy>
        {Array.from({ length: GRANTS_SKELETON_ROWS }, (_, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-7 w-36 rounded-lg" />
            <Skeleton className="size-7 rounded-lg" />
          </li>
        ))}
      </ul>
    )
  }

  if (grants.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">{t("grantsError")}</p>
        <Button variant="outline" size="sm" onClick={() => void grants.refetch()}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  if (grants.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <ul className="flex flex-col divide-y">
      {grants.data.map((share) => (
        <GrantRow
          key={share.id}
          share={share}
          onChangeAccess={onChangeAccess}
          onRevoke={onRevoke}
          busy={busyGroupId === share.groupId}
        />
      ))}
    </ul>
  )
}

function GrantRow({
  share,
  onChangeAccess,
  onRevoke,
  busy,
}: {
  share: ShareWithGroup
  onChangeAccess: (share: ShareWithGroup, access: ProjectAccess) => void
  onRevoke: (share: ShareWithGroup) => void
  busy: boolean
}) {
  const t = useTranslations("projects.share")

  return (
    <li className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{share.group.name}</div>
        <div className="text-xs text-muted-foreground">
          {t("memberCount", { count: share.group._count.members })}
        </div>
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
          // The column is a plain string; the schema is the one place that
          // decides what a stored level may be, and refuses anything else.
          value={shareProjectSchema.shape.access.parse(share.access)}
          onValueChange={(access) => onChangeAccess(share, access)}
          groupName={share.group.name}
          disabled={busy}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={t("revoke", { name: share.group.name })}
          onClick={() => onRevoke(share)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  )
}
