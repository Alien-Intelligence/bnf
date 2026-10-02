// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads all notes with their full body, citations and the
// OCR quality of their cited folios (NoteDetail) for the Carnet view. Passes
// them to CarnetClient, which seeds the per-note query cache with them.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject } from "@/lib/authz/project-access"
import { workspaceStepsFor } from "@/lib/authz/workspace-steps"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { CarnetClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function CarnetPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { projectId } = await params

  const user = await requireSessionUser(
    `/projects/${projectId}/rechercher/carnet`,
  )

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  if (!canReadProject(user, project)) notFound()

  const notes = await NoteQueries.listDetailsForProject(projectId)

  return (
    <CarnetClient
      projectId={projectId}
      initialUser={{ name: user.name, email: user.email }}
      initialWorkspaceSteps={workspaceStepsFor(user, project)}
      initialNotes={notes}
    />
  )
}
