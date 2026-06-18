// app/[locale]/projects/[projectId]/rechercher/carnet/page.tsx
// Server component. Loads all notes with their full body for the Carnet view.
// Passes to CarnetClient which owns citation-click interactivity.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
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
  if (project.ownerId !== user.id && !project.isPublic) notFound()

  const notes = await prisma.note.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  })

  return (
    <CarnetClient
      projectId={projectId}
      initialUser={{ name: user.name, email: user.email }}
      notes={notes}
    />
  )
}
