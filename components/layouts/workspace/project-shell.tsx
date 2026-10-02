"use client"

// components/layouts/workspace/project-shell.tsx
// LayoutWorkspaceProjectShell — the client half of the project layout
// (app/[locale]/projects/[projectId]/layout.tsx): the header once, the step
// page below it, and the two dialogs the header opens — share this project,
// create a project — rendered here at shell level, not inside the buttons
// that open them (playbook/componentization.md, "modals at the page level").
//
// Any component under the shell opens them through
// useWorkspaceProjectDialogs() (./project-dialogs); the header's switcher and
// Share button are the first two entry points.

import { useMemo, useState, type ReactNode } from "react"
import { DialogProjectCreate } from "@/components/dialogs/projects/create"
import { DialogProjectShare } from "@/components/dialogs/projects/share"
import { LayoutWorkspaceHeader } from "./header"
import {
  WorkspaceProjectDialogsContext,
  type WorkspaceProjectDialogs,
} from "./project-dialogs"
import type {
  WorkspaceHeaderProject,
  WorkspaceHeaderViewer,
} from "@/lib/authz/workspace-header"

interface LayoutWorkspaceProjectShellProps {
  viewer: WorkspaceHeaderViewer
  project: WorkspaceHeaderProject
  children: ReactNode
}

export function LayoutWorkspaceProjectShell({
  viewer,
  project,
  children,
}: LayoutWorkspaceProjectShellProps) {
  const [shareOpen, setShareOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const dialogs = useMemo<WorkspaceProjectDialogs>(
    () => ({
      openShare: () => setShareOpen(true),
      openCreateProject: () => setCreateOpen(true),
    }),
    [],
  )

  return (
    <WorkspaceProjectDialogsContext.Provider value={dialogs}>
      <div className="flex h-screen flex-col">
        <LayoutWorkspaceHeader viewer={viewer} project={project} />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>

      {project.mayShare && (
        <DialogProjectShare
          projectId={project.id}
          projectName={project.name}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
      <DialogProjectCreate open={createOpen} onOpenChange={setCreateOpen} />
    </WorkspaceProjectDialogsContext.Provider>
  )
}
