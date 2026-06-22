// app/[locale]/projects/[projectId]/rechercher/page.tsx
// Server component. Authenticates, resolves project, ensures a default
// research session exists, pre-loads note list, and hands everything to
// RechercherClient as initial* props. No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { CorpusQueries } from "@/models/corpus/queries"
import { SessionService } from "@/models/sessions/service"
import { SessionQueries } from "@/models/sessions/queries"
import { OnboardingQueries } from "@/models/onboarding/queries"
import { ONBOARDING_INTRO } from "@/models/onboarding/schema"
import { RAG_CLUSTER_ID } from "@/lib/constants"
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

  const [session, initialNotes, seenIntros] = await Promise.all([
    SessionService.ensureDefaultForScope(projectId, "research"),
    NoteQueries.listForProject(projectId),
    OnboardingQueries.listSeen(user.id),
  ])

  // Loaded after ensureDefaultForScope so the just-created default session is in
  // the list. The doc count reflects what is actually indexed in the cluster —
  // the last successfully ingested version, not the (possibly newer) head.
  const [initialSessions, ingestedArks] = await Promise.all([
    SessionQueries.listForProject(projectId, "research"),
    project.ingestedVersionId
      ? CorpusQueries.membershipArks(project.ingestedVersionId)
      : Promise.resolve([]),
  ])

  const isIngested = project.ingestedVersionId !== null

  return (
    <RechercherClient
      projectId={projectId}
      locale={locale}
      projectName={project.name}
      initialUser={{ name: user.name, email: user.email }}
      initialSessionId={session.id}
      initialSessions={initialSessions}
      initialNotes={initialNotes}
      isIngested={isIngested}
      clusterId={RAG_CLUSTER_ID}
      docCount={ingestedArks.length}
      introSeen={seenIntros.includes(ONBOARDING_INTRO.RESEARCH)}
    />
  )
}
