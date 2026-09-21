"use client"

// components/dialogs/projects/share.tsx
// DialogProjectShare — grant a group read or write access to a project, and
// revoke existing grants. Owner-only; the tile only offers it when the caller
// resolves to `owner`, and POST /api/projects/:id/shares enforces the same.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FormProjectShare } from "@/components/forms/projects/share"
import { useGroups } from "@/hooks/api/groups"
import {
  useProjectShares,
  useShareProject,
  useUnshareProject,
} from "@/hooks/api/projects"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import { CardProjectShareRow } from "@/components/cards/projects/share-row"
import type { ProjectListItem } from "@/models/projects/schema"
import type { ShareProjectInput } from "@/models/projects/types"

interface DialogProjectShareProps {
  project: ProjectListItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogProjectShare({
  project,
  open,
  onOpenChange,
}: DialogProjectShareProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")

  const groups = useGroups()
  const shares = useProjectShares(project.id, open)
  const shareProject = useShareProject(project.id)
  const unshareProject = useUnshareProject(project.id)

  // Granting and revoking fail for different reasons and are read in different
  // places, so each keeps its own message rather than overwriting the other's.
  const [grantError, setGrantError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A group already granted access is changed through its own row, not added
  // twice — the (project, group) pair is unique by construction.
  const sharedGroupIds = new Set((shares.data ?? []).map((s) => s.groupId))
  const available = (groups.data ?? []).filter((g) => !sharedGroupIds.has(g.id))

  // Returns whether the grant landed, so the form knows whether to clear the
  // selection. Swallowing the rejection AND resetting would wipe the owner's
  // chosen group every time the server refused.
  const onGrant = async (data: ShareProjectInput): Promise<boolean> => {
    setGrantError(null)
    try {
      await shareProject.mutateAsync(data)
      return true
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : tCommon("error"))
      return false
    }
  }

  const onChangeAccess = async (gid: string, value: string | null) => {
    if (value !== PROJECT_ACCESS.READ && value !== PROJECT_ACCESS.WRITE) return
    setError(null)
    try {
      await shareProject.mutateAsync({ groupId: gid, access: value })
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  const onRevoke = async (gid: string) => {
    setError(null)
    try {
      await unshareProject.mutateAsync(gid)
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: project.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* Grant. A failed groups fetch must not read as "you have no
              groups" — that sentence sends the owner to an administrator to
              fix something that is not broken. */}
          {groups.isLoading ? (
            <Skeleton className="h-10 rounded-md" />
          ) : groups.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{t("groupsError")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => groups.refetch()}
              >
                {tCommon("tryAgain")}
              </Button>
            </div>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {(groups.data ?? []).length === 0
                ? t("noGroups")
                : t("allGroupsShared")}
            </p>
          ) : (
            <FormProjectShare
              groups={available}
              onSubmit={onGrant}
              serverError={grantError}
            />
          )}

          {/* Current grants */}
          {shares.isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : shares.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{tCommon("error")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => shares.refetch()}
              >
                {tCommon("tryAgain")}
              </Button>
            </div>
          ) : (shares.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {shares.data?.map((share) => (
                <CardProjectShareRow
                  key={share.id}
                  share={share}
                  onChangeAccess={onChangeAccess}
                  onRevoke={onRevoke}
                  revoking={unshareProject.isPending}
                />
              ))}
            </ul>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
