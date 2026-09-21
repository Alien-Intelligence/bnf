// app/[locale]/projects/[projectId]/rechercher/page.tsx
// Server component. Authenticates, resolves project, ensures a default
// research session exists, pre-loads note list, and hands everything to
// RechercherClient as initial* props. No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canReadProject } from "@/lib/authz/project-access"
import { workspaceStepsFor } from "@/lib/authz/workspace-steps"
import {
  CORPUS_SOURCE_STATE,
  corpusProjectId,
  corpusSourceState,
} from "@/lib/authz/corpus-source"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { CorpusQueries } from "@/models/corpus/queries"
import { SessionService } from "@/models/sessions/service"
import { SessionQueries } from "@/models/sessions/queries"
import { OnboardingQueries } from "@/models/onboarding/queries"
import { ONBOARDING_INTRO } from "@/models/onboarding/schema"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { RAG_CLUSTER_ID } from "@/lib/constants"
import { env } from "@/lib/env"
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
  if (!canReadProject(user, project)) notFound()

  // A derived project reads the source's corpus; its notes, memory and
  // sessions stay local. See lib/authz/corpus-source.ts.
  const corpusId = corpusProjectId(project)
  const sourceState = corpusSourceState(project)
  const revoked = sourceState === CORPUS_SOURCE_STATE.REVOKED

  const workspaceSteps = workspaceStepsFor(user, project)

  const [session, initialNotes, seenIntros] = await Promise.all([
    SessionService.ensureDefaultForScope(projectId, SESSION_SCOPE.RESEARCH),
    NoteQueries.listForProject(projectId),
    OnboardingQueries.listSeen(user.id),
  ])

  // Loaded after ensureDefaultForScope so the just-created default session is in
  // the list. The doc count reflects what is actually indexed in the cluster —
  // the last successfully ingested version, not the (possibly newer) head.
  const corpusProject =
    corpusId === projectId
      ? project
      : await ProjectQueries.get(corpusId)

  const ingestedVersionId = revoked
    ? null
    : (corpusProject?.ingestedVersionId ?? null)

  const [initialSessions, ingestedArks] = await Promise.all([
    SessionQueries.listForProject(projectId, SESSION_SCOPE.RESEARCH),
    ingestedVersionId
      ? CorpusQueries.membershipArks(ingestedVersionId)
      : Promise.resolve([]),
  ])

  // A revoked grant is not "not ingested": the client renders the two
  // differently, so the state is passed through rather than flattened.
  const isIngested = ingestedVersionId !== null

  // Open on the most-recently-active session (the list is updatedAt desc), not
  // the oldest. ensureDefaultForScope only guarantees one exists; its return is
  // the createdAt-asc first session, so use it only as a fallback.
  const initialSessionId = initialSessions[0]?.id ?? session.id

  return (
    <RechercherClient
      projectId={projectId}
      locale={locale}
      projectName={project.name}
      initialUser={{ name: user.name, email: user.email }}
      initialSessionId={initialSessionId}
      initialSessions={initialSessions}
      initialNotes={initialNotes}
      initialIsIngested={isIngested}
      initialWorkspaceSteps={workspaceSteps}
      initialCorpusSourceState={sourceState}
      initialCorpusSourceName={corpusProject?.name ?? null}
      initialClusterId={RAG_CLUSTER_ID}
      initialDocCount={ingestedArks.length}
      initialIntroSeen={seenIntros.includes(ONBOARDING_INTRO.RESEARCH)}
      initialAgentProvider={env.AGENT_PROVIDER}
    />
  )
}
