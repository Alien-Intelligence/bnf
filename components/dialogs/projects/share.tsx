"use client"

// components/dialogs/projects/share.tsx
// DialogProjectShare — grant a group read or write access to a project, change
// a grant's level, and revoke grants. Owner-only: the tile and the workspace
// header only offer it when the caller may share (ProjectPolicy.share), and
// POST /api/projects/:id/shares enforces the same.
//
// Two cards — « Donner accès à un groupe » and « Groupes ayant accès (n) » —
// plus, at this level, the confirmation for revoking a grant that derived
// workspaces depend on. Every success says so with a toast; every failure is
// shown in the user's language (API failures map by status to
// projects.share.errors.*, never the server's or a developer's raw text).
//
// All transient state (the pending revoke, the last error) lives in
// ShareDialogBody, inside DialogContent, which unmounts when the dialog
// closes — however it is closed — so a reopened dialog always starts clean.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toast"
import { AlertDialogProjectRevokeShare } from "@/components/alerts/projects/revoke-share"
import { CardProjectShareAdd } from "@/components/cards/projects/share-add"
import { CardProjectShareGrants } from "@/components/cards/projects/share-grants"
import { useGroups } from "@/hooks/api/groups"
import {
  useProjectShares,
  useShareProject,
  useUnshareProject,
} from "@/hooks/api/projects"
import {
  SHARE_ERROR_REASON,
  ShareGrantError,
  shareErrorReason,
} from "@/components/forms/projects/share"
import type { ProjectAccess } from "@/lib/authz/project-access"
import type { ShareWithGroup } from "@/models/projects/schema"
import type { ShareProjectInput } from "@/models/projects/types"

interface DialogProjectShareProps {
  projectId: string
  projectName: string
  /** Whether the viewer can create groups (offered when they have none). */
  viewerIsAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogProjectShare({
  projectId,
  projectName,
  viewerIsAdmin,
  open,
  onOpenChange,
}: DialogProjectShareProps) {
  const t = useTranslations("projects.share")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-lg, not max-w-lg: the primitive's sm:max-w-sm wins over an
          unprefixed width from sm up, which squeezed the grant row. */}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title", { name: projectName })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ShareDialogBody projectId={projectId} viewerIsAdmin={viewerIsAdmin} />
      </DialogContent>
    </Dialog>
  )
}

function ShareDialogBody({
  projectId,
  viewerIsAdmin,
}: {
  projectId: string
  viewerIsAdmin: boolean
}) {
  const t = useTranslations("projects.share")
  const { toast } = useToast()
  const tError = useTranslations("projects.share.errors")

  const groups = useGroups()
  const shares = useProjectShares(projectId)
  const shareProject = useShareProject(projectId)
  const unshareProject = useUnshareProject(projectId)

  // A grant waiting for the revoke confirmation, and the last failed change or
  // revoke (a failed grant is shown by the form, on its group field).
  const [revokeTarget, setRevokeTarget] = useState<ShareWithGroup | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const levelLabel = (access: ProjectAccess): string => t(`level.${access}`)

  const grantedGroupIds = new Set((shares.data ?? []).map((s) => s.groupId))

  // A failed request is logged with its original error and shown as a
  // translated sentence (projects.share.errors.*), never the raw text.
  const report = (what: string, e: unknown): string => {
    console.error(`[share] ${what} failed`, e)
    return tError(shareErrorReason(e))
  }

  // Rejects with a ShareGrantError (the reason, the original as `cause`);
  // FormProjectShare shows the reason on its group field.
  const onGrant = async (data: ShareProjectInput): Promise<void> => {
    let updated: ShareWithGroup[]
    try {
      updated = await shareProject.mutateAsync(data)
    } catch (e) {
      console.error("[share] grant failed", e)
      throw new ShareGrantError(shareErrorReason(e), { cause: e })
    }
    // The answer is the full grant list; the new row names its group.
    const granted = updated.find((s) => s.groupId === data.groupId)
    if (!granted) {
      const missing = new Error(`Grant to ${data.groupId} missing from the server's answer`)
      console.error("[share] grant answer", missing)
      throw new ShareGrantError(SHARE_ERROR_REASON.GENERIC, { cause: missing })
    }
    toast(t("granted", { group: granted.group.name, level: levelLabel(data.access) }))
  }

  const onChangeAccess = async (share: ShareWithGroup, access: ProjectAccess) => {
    setActionError(null)
    try {
      await shareProject.mutateAsync({ groupId: share.groupId, access })
    } catch (e) {
      setActionError(report("level change", e))
    }
  }

  const revoke = async (share: ShareWithGroup) => {
    setActionError(null)
    try {
      await unshareProject.mutateAsync(share.groupId)
      toast(t("revoked", { name: share.group.name }))
    } catch (e) {
      setActionError(report("revoke", e))
    } finally {
      setRevokeTarget(null)
    }
  }

  // A grant nothing is built on goes at once; one that feeds derived
  // workspaces asks first.
  const onRevoke = (share: ShareWithGroup) => {
    if (share.derivedCount > 0) {
      setRevokeTarget(share)
      return
    }
    void revoke(share)
  }

  // Only the row being changed or revoked is disabled, not every row.
  const busyGroupId = (): string | null => {
    if (unshareProject.isPending) return unshareProject.variables
    if (shareProject.isPending) return shareProject.variables.groupId
    return null
  }

  return (
    <div className="flex flex-col gap-4">
      <CardProjectShareAdd
        groups={groups}
        grantedGroupIds={grantedGroupIds}
        viewerIsAdmin={viewerIsAdmin}
        onGrant={onGrant}
      />
      <CardProjectShareGrants
        grants={shares}
        onChangeAccess={(share, access) => void onChangeAccess(share, access)}
        onRevoke={onRevoke}
        busyGroupId={busyGroupId()}
      />
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {revokeTarget && (
        <AlertDialogProjectRevokeShare
          open
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null)
          }}
          groupName={revokeTarget.group.name}
          derivedCount={revokeTarget.derivedCount}
          onConfirm={() => void revoke(revokeTarget)}
          pending={unshareProject.isPending}
        />
      )}
    </div>
  )
}
