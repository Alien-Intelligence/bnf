// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads the project's note list (a query — a page reads
// through queries only, playbook/api-layers.md) and passes it to CarnetClient,
// which seeds the note-list cache with it and fetches each note's detail (body,
// citations, OCR quality — NoteDetail) through GET /api/notes/:nid, the one
// place that enrichment is served (found bug B8: the carnet reconciles with
// later changes).

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject } from "@/lib/authz/project-access"
import { workspaceStepsFor } from "@/lib/authz/workspace-steps"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { ROUTES } from "@/lib/constants"
import { CarnetClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function CarnetPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { projectId } = await params

  const user = await requireSessionUser(ROUTES.carnet(projectId))

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  if (!canReadProject(user, project)) notFound()

  const noteList = await NoteQueries.listForProject(projectId)

  return (
    <CarnetClient
      projectId={projectId}
      initialUser={{ name: user.name, email: user.email }}
      initialWorkspaceSteps={workspaceStepsFor(user, project)}
      initialNoteList={noteList}
    />
  )
}
