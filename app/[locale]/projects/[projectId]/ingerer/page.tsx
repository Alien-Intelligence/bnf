// app/[locale]/projects/[projectId]/ingerer/page.tsx
// Server component. Authenticates, resolves the project, computes the plain-
// language delta preview (already-consultable count + what a run would add),
// any active ingest job, and recent job history. Passes everything to
// IngererClient as initial* props. No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { redirect } from "@/i18n/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { canWriteProject } from "@/lib/authz/project-access"
import { isDerived } from "@/lib/authz/corpus-source"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import { serializeIngestJob } from "@/models/ingest/types"
import { INGEST_RECENT_JOBS_LIMIT, ROUTES } from "@/lib/constants"
import { IngererClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function IngererPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { locale, projectId } = await params

  const user = await requireSessionUser(ROUTES.ingerer(projectId))

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  // Ingestion indexes the corpus into the cluster: write access, and only on a
  // project that owns its corpus.
  if (!canWriteProject(user, project)) notFound()
  if (isDerived(project)) redirect({ href: ROUTES.rechercher(projectId), locale })

  const [deltaPreview, activeJob, recentJobs] = await Promise.all([
    IngestService.previewDelta(project),
    IngestQueries.activeForProject(projectId),
    IngestQueries.listForProject(projectId, INGEST_RECENT_JOBS_LIMIT),
  ])

  return (
    <IngererClient
      projectId={projectId}
      initialDeltaPreview={deltaPreview}
      initialActiveJobId={activeJob?.id ?? null}
      initialRecentJobs={recentJobs.map(({ targetVersion, baseVersion, ...job }) => ({
        ...serializeIngestJob(job),
        targetVersionSeq: targetVersion.seq,
        baseVersionSeq: baseVersion?.seq ?? null,
      }))}
    />
  )
}
