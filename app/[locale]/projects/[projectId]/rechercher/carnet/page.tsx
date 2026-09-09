// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads all notes with their full body for the Carnet view.
// Passes to CarnetClient which owns citation-click interactivity.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import { CORPUS_SOURCE_STATE, corpusSourceState } from "@/lib/authz/corpus-source"
import { RESEARCH_ONLY_STEPS, WORKSPACE_STEPS } from "@/lib/constants"
import { ProjectQueries } from "@/models/projects/queries"
import { prisma } from "@/lib/db"
import { CarnetClient } from "./carnet-client"

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

  // Mirrors the Rechercher page: the header must not offer steps this user
  // would be bounced out of.
  const workspaceSteps =
    canWriteProject(user, project) &&
    corpusSourceState(project) === CORPUS_SOURCE_STATE.OWN
      ? WORKSPACE_STEPS
      : RESEARCH_ONLY_STEPS

  const notes = await prisma.note.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  })

  return (
    <CarnetClient
      projectId={projectId}
      initialUser={{ name: user.name, email: user.email }}
      workspaceSteps={workspaceSteps}
      notes={notes}
    />
  )
}
