// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads the project's note list and every note with its full
// body, citations and the OCR quality of its cited folios (NoteDetail). Passes
// both to CarnetClient, which seeds the note-list and per-note query caches
// with them (found bug B8: the carnet reconciles with later changes).

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject } from "@/lib/authz/project-access"
import { workspaceStepsFor } from "@/lib/authz/workspace-steps"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { NoteService } from "@/models/notes/service"
import { corpusProjectId } from "@/lib/authz/corpus-source"
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

  const [noteList, details] = await Promise.all([
    NoteQueries.listForProject(projectId),
    NoteQueries.listWithCitationsForProject(projectId).then((notes) =>
      NoteService.details(notes, corpusProjectId(project)),
    ),
  ])

  return (
    <CarnetClient
      projectId={projectId}
      initialUser={{ name: user.name, email: user.email }}
      initialWorkspaceSteps={workspaceStepsFor(user, project)}
      initialNoteList={noteList}
      initialNoteDetails={details}
    />
  )
}
