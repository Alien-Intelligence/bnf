"use client"

// components/layouts/workspace/project-nav.tsx
// LayoutWorkspaceProjectNav — the project cluster of the workspace header:
// « Projets › [Projet ▾] [Partager] ». Rendered only inside a project, under
// LayoutWorkspaceProjectShell, whose dialogs the switcher and the Share
// button open.

import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { ROUTES } from "@/lib/constants"
import { ButtonProjectShare } from "@/components/buttons/projects/share"
import { Separator } from "@/components/ui/separator"
import { DropdownProjectSwitcher } from "@/components/dropdowns/projects/switcher"
import { useWorkspaceProjectDialogs } from "./project-dialogs"
import type { WorkspaceHeaderProject } from "@/lib/authz/workspace-header"

export function LayoutWorkspaceProjectNav({ project }: { project: WorkspaceHeaderProject }) {
  const t = useTranslations("nav")
  const dialogs = useWorkspaceProjectDialogs()

  return (
    <>
      <Separator orientation="vertical" className="data-vertical:h-6.5 data-vertical:self-center" />
      <div className="flex min-w-0 items-center gap-1.5">
        <Link
          href={ROUTES.projects}
          className="rounded-sm text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t("projectsCrumb")}
        </Link>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <DropdownProjectSwitcher
          projectId={project.id}
          projectName={project.name}
          onCreateProject={dialogs.openCreateProject}
        />
      </div>
      {dialogs.openShare && <ButtonProjectShare onClick={dialogs.openShare} />}
    </>
  )
}
