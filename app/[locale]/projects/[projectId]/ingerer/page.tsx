// app/[locale]/projects/[projectId]/ingerer/page.tsx
// Server component. Authenticates, resolves the project, computes the plain-
// language delta preview (already-consultable count + what a run would add),
// any active ingest job, and recent job history. Passes everything to
// IngererClient as initial* props. No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import { serializeIngestJob } from "@/models/ingest/types"
import { IngererClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function IngererPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { projectId } = await params

  const user = await requireSessionUser(`/projects/${projectId}/ingerer`)

  const project = await ProjectQueries.get(projectId)
  if (!project) notFound()
  if (project.ownerId !== user.id && !project.isPublic) notFound()

  const [deltaPreview, activeJob, recentJobs] = await Promise.all([
    IngestService.previewDelta(project),
    IngestQueries.activeForProject(projectId),
    IngestQueries.listForProject(projectId, 20),
  ])

  return (
    <IngererClient
      projectId={projectId}
      initialUser={{ name: user.name ?? undefined, email: user.email }}
      alreadyConsultable={deltaPreview.already}
      deltaPreview={{
        added: deltaPreview.added,
        removed: deltaPreview.removed,
        excluded: deltaPreview.excluded,
        excludedNoText: deltaPreview.excludedNoText,
        excludedNoScan: deltaPreview.excludedNoScan,
        paidOcr: deltaPreview.paidOcr,
        paidOcrBudget: deltaPreview.paidOcrBudget,
      }}
      activeJobId={activeJob?.id ?? null}
      initialRecentJobs={recentJobs.map(({ targetVersion, baseVersion, ...job }) => ({
        ...serializeIngestJob(job),
        targetVersionSeq: targetVersion.seq,
        baseVersionSeq: baseVersion?.seq ?? null,
      }))}
    />
  )
}
