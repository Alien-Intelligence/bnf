"use client"

// app/[locale]/projects/client.tsx
// ProjectsClient — the branded projects grid. Seeds the TanStack cache from the
// server-fetched initialProjects, owns the create-dialog open state, and renders
// loading / error / empty / content as distinct branches (playbook/ui-states).

import { useState } from "react"
import { FolderOpen, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { useProjects } from "@/hooks/api/projects"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { CardProjectTile } from "@/components/cards/projects/tile"
import { DialogProjectCreate } from "@/components/dialogs/projects/create"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { ProjectListItem } from "@/models/projects/schema"

interface ProjectsClientProps {
  initialProjects: ProjectListItem[]
  user: { name?: string; email: string }
}

export function ProjectsClient({
  initialProjects,
  user,
}: ProjectsClientProps) {
  const t = useTranslations("projects")
  const [createOpen, setCreateOpen] = useState(false)
  const { data: projects, isLoading, isError } = useProjects({
    initialData: initialProjects,
  })

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader user={user} />

      <main className="mx-auto w-full max-w-5xl px-6 py-12">
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">{t("loadError")}</p>
        ) : !projects || projects.length === 0 ? (
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <CardProjectTile key={project.id} project={project} />
            ))}
          </div>
        )}
      </main>

      <DialogProjectCreate open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
