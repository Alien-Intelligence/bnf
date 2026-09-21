"use client"

// app/[locale]/projects/client.tsx
// ProjectsClient — the branded projects grid. Seeds the TanStack cache from the
// server-fetched initialProjects, owns the create/share/derive dialog state, and
// renders loading / error / empty / content as distinct branches
// (playbook/ui-states).
//
// Two sections: « Mes projets » (owned) and « Partagés avec moi » (everything
// else the caller can see). The split is on actual ownership, NOT on the
// resolved access level: an admin resolves to `owner` on every project (rule 2
// of the access table), and filing someone else's corpus under « Mes projets »
// would be a lie. Visibility itself is still decided server-side by
// lib/authz/project-access.ts — the client never re-decides who may see what.

import { useState } from "react"
import { FolderOpen, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useProjects } from "@/hooks/api/projects"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { CardProjectTile } from "@/components/cards/projects/tile"
import { DialogProjectCreate } from "@/components/dialogs/projects/create"
import { DialogProjectShare } from "@/components/dialogs/projects/share"
import { DialogProjectDerive } from "@/components/dialogs/projects/derive"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { ProjectListItem } from "@/models/projects/schema"

interface ProjectsClientProps {
  initialProjects: ProjectListItem[]
  user: { id: string; name?: string; email: string }
  isAdmin?: boolean
}

export function ProjectsClient({
  initialProjects,
  user,
  isAdmin = false,
}: ProjectsClientProps) {
  const t = useTranslations("projects")
  const [createOpen, setCreateOpen] = useState(false)
  const [sharing, setSharing] = useState<ProjectListItem | null>(null)
  const [deriving, setDeriving] = useState<ProjectListItem | null>(null)

  const { data: projects, isLoading, isError } = useProjects({
    initialData: initialProjects,
  })

  const owned = (projects ?? []).filter((p) => p.ownerId === user.id)
  const shared = (projects ?? []).filter((p) => p.ownerId !== user.id)

  const grid = (items: ProjectListItem[]) => (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((project) => (
        <CardProjectTile
          key={project.id}
          project={project}
          currentUserId={user.id}
          onShare={() => setSharing(project)}
          onDerive={() => setDeriving(project)}
        />
      ))}
    </div>
  )

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader user={user} isAdmin={isAdmin} />

      <main className="mx-auto w-full max-w-7xl px-6 py-12">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div className="space-y-1">
            <span className="mono-eyebrow">{t("eyebrow")}</span>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("new")}
          </Button>
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">{t("loadError")}</p>
        ) : owned.length === 0 && shared.length === 0 ? (
          <LayoutSharedEmptyState
            icon={FolderOpen}
            title={t("empty")}
            description={t("emptyHint")}
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                {t("new")}
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-10">
            {/* The owned section is shown even when empty as long as something
                is shared, so a reader-only account still sees where their own
                projects would go. */}
            <section className="space-y-4">
              <h2 className="text-sm font-medium text-muted-foreground">
                {t("section.mine")}
              </h2>
              {owned.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("section.mineEmpty")}
                </p>
              ) : (
                grid(owned)
              )}
            </section>

            {shared.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {t("section.shared")}
                </h2>
                {grid(shared)}
              </section>
            )}
          </div>
        )}
      </main>

      <DialogProjectCreate open={createOpen} onOpenChange={setCreateOpen} />

      {sharing && (
        <DialogProjectShare
          project={sharing}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(null)
          }}
        />
      )}

      {deriving && (
        <DialogProjectDerive
          source={deriving}
          open
          onOpenChange={(open) => {
            if (!open) setDeriving(null)
          }}
        />
      )}
    </div>
  )
}
