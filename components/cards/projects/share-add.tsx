"use client"

// components/cards/projects/share-add.tsx
// CardProjectShareAdd — « Donner accès à un groupe » in the share dialog: the
// groups the owner may still grant, as loading → error → empty → form.
//
// A failed groups fetch must not read as "you have no groups": that sentence
// sends the owner to an administrator to fix something that is not broken.

import type { UseQueryResult } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { FormProjectShare } from "@/components/forms/projects/share"
import { ROUTES } from "@/lib/constants"
import type { GroupListItem } from "@/models/groups/schema"
import type { ShareProjectInput } from "@/models/projects/types"

interface CardProjectShareAddProps {
  groups: UseQueryResult<GroupListItem[]>
  /** The current grants, once known: their groups are changed in place, not added. */
  grantedGroupIds: ReadonlySet<string>
  /** Whether the viewer can create groups (the admin console). */
  viewerIsAdmin: boolean
  onGrant: (data: ShareProjectInput) => Promise<void>
}

export function CardProjectShareAdd(props: CardProjectShareAddProps) {
  const t = useTranslations("projects.share")
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>{t("addHeading")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ShareAddBody {...props} />
      </CardContent>
    </Card>
  )
}

function ShareAddBody({ groups, grantedGroupIds, viewerIsAdmin, onGrant }: CardProjectShareAddProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")

  if (groups.isPending) {
    // The form's own shape — two labelled fields, the button, the owner note —
    // so nothing moves when it arrives.
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-8 rounded-lg" />
          </div>
          <div className="flex w-36 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-12" />
            <Skeleton className="h-8 rounded-lg" />
          </div>
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }

  if (groups.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">{t("groupsError")}</p>
        <Button variant="outline" size="sm" onClick={() => void groups.refetch()}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  if (groups.data.length === 0) {
    // GET /api/groups lists an admin's every group and a member's own: empty
    // means "no group exists" for an admin, "you are in none" for a member,
    // and only an admin can change either from here.
    if (viewerIsAdmin) {
      return (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">{t("noGroupsAdmin")}</p>
          <Link
            href={ROUTES.adminGroups}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t("createGroup")}
          </Link>
        </div>
      )
    }
    return <p className="text-sm text-muted-foreground">{t("noGroups")}</p>
  }

  const available = groups.data.filter((g) => !grantedGroupIds.has(g.id))
  if (available.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("allGroupsShared")}</p>
  }

  return <FormProjectShare groups={available} onSubmit={onGrant} />
}
