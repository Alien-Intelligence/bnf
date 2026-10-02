// app/[locale]/projects/[projectId]/layout.tsx
// Shell for every project step (Constituer, Ingérer, Rechercher, Carnet): it
// loads what the header needs and hands it to the client shell, which renders
// the header ONCE (and the dialogs it opens), so the share button, the
// « Projets » crumb and the admin link are decided here from server data instead of being threaded through six client mounts (which is
// how the admin link went missing on every project page).
//
// It never gates. A layout does not re-render on navigation and cannot see
// the pathname, so it can neither keep a session check fresh nor build the
// right `?next=` (Next 16 authentication guide, "Layouts and auth checks";
// layout.md "Pathname"). The pages keep requireSessionUser(<own path>) and
// their access checks. With no session, or no project this user may read,
// it renders the page bare: the page then redirects or answers notFound(),
// and a 404 never shows the project's name.

import type { ReactNode } from "react"
import { findSessionUser } from "@/lib/auth-helpers"
import {
  workspaceHeaderProject,
  workspaceHeaderViewer,
} from "@/lib/authz/workspace-header"
import { ProjectQueries } from "@/models/projects/queries"
import { LayoutWorkspaceProjectShell } from "@/components/layouts/workspace/project-shell"

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string; projectId: string }>
}) {
  const { projectId } = await params

  // Memoized with React cache: the page's requireSessionUser reuses this
  // lookup within the same render.
  const user = await findSessionUser()
  if (!user) return children

  const project = await ProjectQueries.get(projectId)
  if (!project) return children
  // null when the user may not read the project (canReadProject).
  const headerProject = workspaceHeaderProject(user, project)
  if (!headerProject) return children

  return (
    <LayoutWorkspaceProjectShell viewer={workspaceHeaderViewer(user)} project={headerProject}>
      {children}
    </LayoutWorkspaceProjectShell>
  )
}
