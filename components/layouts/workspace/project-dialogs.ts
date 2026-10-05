"use client"

// components/layouts/workspace/project-dialogs.ts
// The project shell's dialog openers, as context: LayoutWorkspaceProjectShell
// provides them and renders the dialogs; any component under it opens them
// without owning their state. A separate module so the shell, the header and
// the header's project cluster do not import each other in a cycle.

import { createContext, useContext } from "react"

export type WorkspaceProjectDialogs = {
  /** Opens the share dialog; null when the viewer may not share this project
   *  (the dialog is not mounted), so no caller can wire a dead button. */
  openShare: (() => void) | null
  openCreateProject: () => void
}

export const WorkspaceProjectDialogsContext = createContext<WorkspaceProjectDialogs | null>(null)

export function useWorkspaceProjectDialogs(): WorkspaceProjectDialogs {
  const ctx = useContext(WorkspaceProjectDialogsContext)
  if (!ctx) {
    throw new Error("useWorkspaceProjectDialogs must be used within LayoutWorkspaceProjectShell")
  }
  return ctx
}
