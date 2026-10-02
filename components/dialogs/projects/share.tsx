"use client"

// components/dialogs/projects/share.tsx
// DialogProjectShare — grant a group read or write access to a project, and
// revoke existing grants. Owner-only; the tile and the workspace header only
// offer it when the caller may share (ProjectPolicy.share), and
// POST /api/projects/:id/shares enforces the same.

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
import { useToast } from "@/components/ui/toast"
import { FormProjectShare } from "@/components/forms/projects/share"
import { useGroups } from "@/hooks/api/groups"
import {
  useProjectShares,
  useShareProject,
  useUnshareProject,
} from "@/hooks/api/projects"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import { CardProjectShareRow } from "@/components/cards/projects/share-row"
import type { ShareProjectInput } from "@/models/projects/types"
import type { ShareWithGroup } from "@/models/projects/schema"

interface DialogProjectShareProps {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogProjectShare({
  projectId,
  projectName,
  open,
  onOpenChange,
}: DialogProjectShareProps) {
  const t = useTranslations("projects.share")
  const tCommon = useTranslations("common")
  const { toast } = useToast()

  const groups = useGroups()
  const shares = useProjectShares(projectId, open)
  const shareProject = useShareProject(projectId)
  const unshareProject = useUnshareProject(projectId)

  // Granting and revoking fail for different reasons and are read in different
  // places, so each keeps its own message rather than overwriting the other's.
  const [grantError, setGrantError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The grant whose revoke is waiting for confirmation. Revoking a grant that
  // feeds derived workspaces severs their corpus, so it asks first — inline,
  // in the row, rather than a modal stacked on this modal.
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null)

  // A pending confirmation never survives the dialog closing: reopening it
  // must not greet the owner with a half-finished destructive action. Reset
  // while rendering on the open → closed edge (React's "adjusting state when
  // a prop changes"), not in an effect, which would render the stale row once.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setConfirmingRevoke(null)
  }

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
      // The form only offers `available`, so the group is there; resolved
      // before the request so the confirmation can name it.
      const group = available.find((g) => g.id === data.groupId)
      if (!group) throw new Error(`Group ${data.groupId} is not grantable here`)
      await shareProject.mutateAsync(data)
      toast(t("granted", { group: group.name, level: levelLabel(data.access) }))
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

  const levelLabel = (access: string): string =>
    access === PROJECT_ACCESS.WRITE ? t("level.write") : t("level.read")

  const revoke = async (share: ShareWithGroup) => {
    setError(null)
    try {
      await unshareProject.mutateAsync(share.groupId)
      setConfirmingRevoke(null)
      toast(t("revoked", { name: share.group.name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon("error"))
    }
  }

  // A grant nothing is built on goes at once; one that feeds derived
  // workspaces asks first (its row turns into the confirmation).
  const onRevoke = (share: ShareWithGroup) => {
    if (share.derivedCount > 0) {
      setConfirmingRevoke(share.groupId)
      return
    }
    void revoke(share)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-lg, not max-w-lg: the primitive's sm:max-w-sm wins over an
          unprefixed width from sm up, which squeezed the grant row. */}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: projectName })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("addHeading")}</h3>
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
          </section>

          <section className="flex flex-col gap-2">
            {/* Counted only once known: « (0) » while loading would be a lie. */}
            {shares.data && (
              <h3 className="text-sm font-medium">
                {t("currentHeading", { count: shares.data.length })}
              </h3>
            )}
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
                    onRevoke={() => onRevoke(share)}
                    revoking={unshareProject.isPending}
                    confirming={confirmingRevoke === share.groupId}
                    onConfirmRevoke={() => void revoke(share)}
                    onCancelRevoke={() => setConfirmingRevoke(null)}
                  />
                ))}
              </ul>
            )}
          </section>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
