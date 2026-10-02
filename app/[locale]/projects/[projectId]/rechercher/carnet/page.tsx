// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads all notes with their full body for the Carnet view.
// Passes to CarnetClient which owns citation-click interactivity.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject } from "@/lib/authz/project-access"
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

  const notes = await NoteQueries.listForProjectWithBodies(projectId)

  return (
    <CarnetClient
      projectId={projectId}
      initialNotes={notes}
    />
  )
}
