"use client"

// app/[locale]/projects/client.tsx
// ProjectsClient — the branded projects grid. Seeds the TanStack cache from the
// server-fetched initialProjects, owns the create/share/derive dialog state, and
// renders loading / error / empty / content as distinct branches
// (playbook/ui-states).
//
// Three sections: « Mes projets », « Partagés avec moi » and « Projets
// publics », filed by the server-computed `relation` (projectRelation in
// lib/authz/project-access.ts), NOT by the resolved access level: an admin
// resolves to `owner` on every project (rule 2 of the access table), and
// filing someone else's corpus under « Mes projets » would be a lie; a public
// project is not shared with anyone. The client never re-decides who owns or
// may see what.

import { useState } from "react"
import { FolderOpen, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useProjects } from "@/hooks/api/projects"
import { LayoutWorkspaceHeader } from "@/components/layouts/workspace/header"
import { CardProjectTile } from "@/components/cards/projects/tile"
import { DialogProjectCreate } from "@/components/dialogs/projects/create"
import { DialogProjectShare } from "@/components/dialogs/projects/share"
import { DialogProjectDerive } from "@/components/dialogs/projects/derive"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { ProjectListItem } from "@/models/projects/schema"
import type { WorkspaceHeaderViewer } from "@/lib/authz/workspace-header"
import { PROJECT_RELATION } from "@/lib/authz/project-access"

/** Placeholder tiles while the list loads. */
const PROJECTS_SKELETON_TILES = 3

interface ProjectsClientProps {
  initialProjects: ProjectListItem[]
  viewer: WorkspaceHeaderViewer
}

export function ProjectsClient({
  initialProjects,
  viewer,
}: ProjectsClientProps) {
  const t = useTranslations("projects")
  const [createOpen, setCreateOpen] = useState(false)
  const [sharing, setSharing] = useState<ProjectListItem | null>(null)
  const [deriving, setDeriving] = useState<ProjectListItem | null>(null)

  const projects = useProjects({ initialData: initialProjects })

  return (
    <div className="flex min-h-screen flex-col">
      <LayoutWorkspaceHeader viewer={viewer} project={null} />

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

        <ProjectsBody
          projects={projects}
          onCreate={() => setCreateOpen(true)}
          onShare={setSharing}
          onDerive={setDeriving}
        />
      </main>

      <DialogProjectCreate open={createOpen} onOpenChange={setCreateOpen} />

      {sharing && (
        <DialogProjectShare
          projectId={sharing.id}
          projectName={sharing.name}
          viewerIsAdmin={viewer.isAdmin}
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

/** The list: loading → error (with retry) → empty → sections. */
function ProjectsBody({
  projects,
  onCreate,
  onShare,
  onDerive,
}: {
  projects: ReturnType<typeof useProjects>
  onCreate: () => void
  onShare: (project: ProjectListItem) => void
  onDerive: (project: ProjectListItem) => void
}) {
  const t = useTranslations("projects")
  const tCommon = useTranslations("common")

  if (projects.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: PROJECTS_SKELETON_TILES }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    )
  }

  if (projects.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">{t("loadError")}</p>
        <Button variant="outline" size="sm" onClick={() => void projects.refetch()}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  if (projects.data.length === 0) {
    return (
      <LayoutSharedEmptyState
        icon={FolderOpen}
        title={t("empty")}
        description={t("emptyHint")}
        action={
          <Button onClick={onCreate}>
            <Plus className="size-4" />
            {t("new")}
          </Button>
        }
      />
    )
  }

  const owned = projects.data.filter((p) => p.relation === PROJECT_RELATION.OWN)
  const shared = projects.data.filter((p) => p.relation === PROJECT_RELATION.SHARED)
  const publicProjects = projects.data.filter((p) => p.relation === PROJECT_RELATION.PUBLIC)

  const grid = (items: ProjectListItem[]) => (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((project) => (
        <CardProjectTile
          key={project.id}
          project={project}
          onShare={() => onShare(project)}
          onDerive={() => onDerive(project)}
        />
      ))}
    </div>
  )

  return (
    <div className="flex flex-col gap-10">
      {/* The owned section is shown even when empty as long as something
          else is listed, so a reader-only account still sees where their own
          projects would go. */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">{t("section.mine")}</h2>
        {owned.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("section.mineEmpty")}</p>
        ) : (
          grid(owned)
        )}
      </section>

      {shared.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">{t("section.shared")}</h2>
          {grid(shared)}
        </section>
      )}

      {publicProjects.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">{t("section.public")}</h2>
          {grid(publicProjects)}
        </section>
      )}
    </div>
  )
}
