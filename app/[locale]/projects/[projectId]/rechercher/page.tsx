// app/[locale]/projects/[projectId]/rechercher/page.tsx
// Server component. Authenticates, resolves project, ensures a default
// research session exists, pre-loads note list, and hands everything to
// RechercherClient as initial* props. No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { SessionService } from "@/models/sessions/service"
import { RechercherClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function RechercherPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { locale, projectId } = await params

  const user = await requireSessionUser(`/projects/${projectId}/rechercher`)

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  if (project.ownerId !== user.id && !project.isPublic) notFound()

  const [session, initialNotes] = await Promise.all([
    SessionService.ensureDefaultForScope(projectId, "research"),
    NoteQueries.listForProject(projectId),
  ])

  const isIngested = project.ingestedVersionId !== null

  return (
    <RechercherClient
      projectId={projectId}
      locale={locale}
      initialUser={{ name: user.name, email: user.email }}
      initialSessionId={session.id}
      initialNotes={initialNotes}
      isIngested={isIngested}
    />
  )
}
