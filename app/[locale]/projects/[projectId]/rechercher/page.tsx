// app/[locale]/projects/[projectId]/rechercher/page.tsx
// Server component. Authenticates, resolves project, ensures a default
// research session exists, pre-loads note list, and hands everything to
// RechercherClient as initial* props. No interactivity — see client.tsx.
//
// A read-only member cannot research here (a turn is a write), so for them it
// loads only what the read-only state needs, and never creates a session in a
// project they do not own.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import {
  canDeriveResearchFrom,
  canReadProject,
  canWriteProject,
} from "@/lib/authz/project-access"
import {
  CORPUS_SOURCE_STATE,
  CorpusSourceMissingError,
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
import { RAG_CLUSTER_ID, RECHERCHER_MODE, ROUTES } from "@/lib/constants"
import { env } from "@/lib/env"
import { RechercherClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function RechercherPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { locale, projectId } = await params

  const user = await requireSessionUser(ROUTES.rechercher(projectId))

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  if (!canReadProject(user, project)) notFound()

  if (!canWriteProject(user, project)) {
    const [ownerName, existingWorkspace] = await Promise.all([
      ProjectQueries.ownerName(projectId),
      ProjectQueries.latestDerivedOwnedBy(user.id, projectId),
    ])
    return (
      <RechercherClient
        mode={RECHERCHER_MODE.READ_ONLY}
        initialSource={{ id: projectId, name: project.name, ownerName }}
        initialCanDerive={canDeriveResearchFrom(user, project)}
        initialExistingWorkspace={existingWorkspace}
      />
    )
  }

  // A derived project reads the source's corpus; its notes, memory and
  // sessions stay local. See lib/authz/corpus-source.ts.
  const corpusId = corpusProjectId(project)
  const sourceState = corpusSourceState(project)
  const revoked = sourceState === CORPUS_SOURCE_STATE.REVOKED

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
  if (!corpusProject) throw new CorpusSourceMissingError(projectId, corpusId)

  const ingestedVersionId = revoked ? null : corpusProject.ingestedVersionId

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
      mode={RECHERCHER_MODE.WORKSPACE}
      projectId={projectId}
      locale={locale}
      projectName={project.name}
      initialSessionId={initialSessionId}
      initialSessions={initialSessions}
      initialNotes={initialNotes}
      initialIsIngested={isIngested}
      initialCorpusSourceState={sourceState}
      initialCorpusSourceName={corpusProject.name}
      initialClusterId={RAG_CLUSTER_ID}
      initialDocCount={ingestedArks.length}
      initialIntroSeen={seenIntros.includes(ONBOARDING_INTRO.RESEARCH)}
      initialAgentProvider={env.AGENT_PROVIDER}
    />
  )
}
