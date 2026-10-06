"use client"

// components/cards/projects/share-grants.tsx
// CardProjectShareGrants — « Groupes ayant accès (n) » in the share dialog:
// loading → error → empty (pointing at the form above) → one
// CardProjectShareGrant per grant.

import type { UseQueryResult } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CardProjectShareGrant } from "./share-grant"
import type { ProjectAccess } from "@/lib/authz/project-access"
import type { ShareWithGroup } from "@/models/projects/schema"

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
      <div className="flex flex-col gap-2" aria-busy>
        {Array.from({ length: GRANTS_SKELETON_ROWS }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 py-1">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-7 w-36 rounded-lg" />
            <Skeleton className="size-7 rounded-lg" />
          </div>
        ))}
      </div>
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
    <div className="flex flex-col gap-2">
      {grants.data.map((share) => (
        <CardProjectShareGrant
          key={share.id}
          share={share}
          onChangeAccess={onChangeAccess}
          onRevoke={onRevoke}
          busy={busyGroupId === share.groupId}
        />
      ))}
    </div>
  )
}
