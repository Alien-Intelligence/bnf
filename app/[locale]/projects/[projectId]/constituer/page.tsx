// app/[locale]/projects/[projectId]/constituer/page.tsx
// Server component. Authenticates, resolves the project, fetches the head
// corpus snapshot, ensures a default corpus session exists, fetches the
// sessions list, and hands everything to ConstituerClient as initial* props.
// No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { CorpusQueries } from "@/models/corpus/queries"
import { SessionService } from "@/models/sessions/service"
import { SessionQueries } from "@/models/sessions/queries"
import { OnboardingQueries } from "@/models/onboarding/queries"
import { ONBOARDING_INTRO } from "@/models/onboarding/schema"
import { env } from "@/lib/env"
import { ConstituerClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function ConstituerPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { locale, projectId } = await params

  const user = await requireSessionUser(`/projects/${projectId}/constituer`)

  const project = await ProjectQueries.get(projectId)
  if (!project || project.ownerId !== user.id) notFound()

  const [initialCorpus, session] = await Promise.all([
    CorpusQueries.snapshot(projectId, "head"),
    SessionService.ensureDefaultForScope(projectId, "corpus"),
  ])

  // Fetch the sessions list after ensuring the default exists so the list
  // always has at least one entry.
  const initialSessions = await SessionQueries.listForProject(projectId, "corpus")

  const seenIntros = await OnboardingQueries.listSeen(user.id)

  // Open on the most-recently-active session (the list is updatedAt desc), not
  // the oldest. ensureDefaultForScope only guarantees one exists; its return is
  // the createdAt-asc first session, so use it only as a fallback.
  const initialSessionId = initialSessions[0]?.id ?? session.id

  return (
    <ConstituerClient
      locale={locale}
      projectId={projectId}
      initialCorpus={initialCorpus}
      initialUser={{ name: user.name, email: user.email }}
      initialSessionId={initialSessionId}
      initialSessions={initialSessions}
      introSeen={seenIntros.includes(ONBOARDING_INTRO.CORPUS)}
      agentProvider={env.AGENT_PROVIDER}
    />
  )
}
