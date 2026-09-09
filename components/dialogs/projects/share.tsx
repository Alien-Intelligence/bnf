"use client"

// components/dialogs/projects/share.tsx
// DialogProjectShare — grant a group read or write access to a project, and
// revoke existing grants. Owner-only; the tile only offers it when the caller
// resolves to `owner`, and POST /api/projects/:id/shares enforces the same.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useGroups } from "@/hooks/api/groups"
import {
  useProjectShares,
  useShareProject,
  useUnshareProject,
} from "@/hooks/api/projects"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import type { ProjectAccess } from "@/lib/authz/project-access"
import type { ProjectListItem } from "@/models/projects/schema"

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

  const [groupId, setGroupId] = useState<string>("")
  const [access, setAccess] = useState<ProjectAccess>(PROJECT_ACCESS.READ)
  const [error, setError] = useState<string | null>(null)

  // A group already granted access is changed through its own row, not added
  // twice — the (project, group) pair is unique by construction.
  const sharedGroupIds = new Set((shares.data ?? []).map((s) => s.groupId))
  const available = (groups.data ?? []).filter((g) => !sharedGroupIds.has(g.id))

  const onGrant = async () => {
    if (!groupId) return
    setError(null)
    try {
      await shareProject.mutateAsync({ groupId, access })
      setGroupId("")
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon("error"))
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
          {/* Grant */}
          {groups.isLoading ? (
            <Skeleton className="h-10 rounded-md" />
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {(groups.data ?? []).length === 0
                ? t("noGroups")
                : t("allGroupsShared")}
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1 space-y-1.5">
                <label className="text-sm font-medium">{t("group")}</label>
                <Select
                  value={groupId}
                  onValueChange={(v) => setGroupId(v ?? "")}
                >
                  <SelectTrigger>
                    {/* Base UI renders the raw value unless told how to label
                        it — a bare SelectValue would show the group's uuid. */}
                    <SelectValue placeholder={t("groupPlaceholder")}>
                      {(value: string | null) =>
                        available.find((g) => g.id === value)?.name ??
                        t("groupPlaceholder")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-36 space-y-1.5">
                <label className="text-sm font-medium">{t("access")}</label>
                <Select
                  value={access}
                  onValueChange={(v) => setAccess(v as ProjectAccess)}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(value: string | null) =>
                        value === PROJECT_ACCESS.WRITE
                          ? t("level.write")
                          : t("level.read")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROJECT_ACCESS.READ}>
                      {t("level.read")}
                    </SelectItem>
                    <SelectItem value={PROJECT_ACCESS.WRITE}>
                      {t("level.write")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={onGrant}
                disabled={!groupId || shareProject.isPending}
              >
                {shareProject.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {t("grant")}
              </Button>
            </div>
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
                <li
                  key={share.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {share.group.name}
                    </div>
                    {/* Revoking costs these workspaces their corpus — say so
                        before the owner clicks, not after. */}
                    {share.derivedCount > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {t("derived", { count: share.derivedCount })}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* The level is editable in place: one row per (project,
                        group) means changing it is an update, so requiring a
                        revoke-then-re-share to widen access would be busywork
                        that also breaks any workspace derived from the grant. */}
                    <Select
                      value={share.access}
                      onValueChange={(v) => onChangeAccess(share.groupId, v)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-36"
                        aria-label={t("changeAccess", { name: share.group.name })}
                      >
                        <SelectValue>
                          {(value: string | null) =>
                            value === PROJECT_ACCESS.WRITE
                              ? t("level.write")
                              : t("level.read")
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={PROJECT_ACCESS.READ}>
                          {t("level.read")}
                        </SelectItem>
                        <SelectItem value={PROJECT_ACCESS.WRITE}>
                          {t("level.write")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("revoke", { name: share.group.name })}
                      disabled={unshareProject.isPending}
                      onClick={() => onRevoke(share.groupId)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
