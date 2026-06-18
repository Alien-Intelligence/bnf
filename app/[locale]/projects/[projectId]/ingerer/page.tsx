// app/[locale]/projects/[projectId]/ingerer/page.tsx
// Server component. Authenticates, resolves the project, fetches the head
// corpus snapshot, the last ingested version seq, any active ingest job, and
// recent job history. Passes everything to IngererClient as initial* props.
// No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { CorpusQueries } from "@/models/corpus/queries"
import { IngestQueries } from "@/models/ingest/queries"
import { prisma } from "@/lib/db"
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

  const [head, ingested, activeJob, recentJobs] = await Promise.all([
    CorpusQueries.snapshot(projectId, "head"),
    project.ingestedVersionId
      ? prisma.corpusVersion.findUnique({
          where: { id: project.ingestedVersionId },
          select: { seq: true },
        })
      : Promise.resolve(null),
    IngestQueries.activeForProject(projectId),
    IngestQueries.listForProject(projectId, 20),
  ])

  return (
    <IngererClient
      projectId={projectId}
      initialUser={{ name: user.name ?? undefined, email: user.email }}
      headVersionSeq={head.versionSeq}
      ingestedVersionSeq={ingested?.seq ?? null}
      deltaPreview={{ added: head.total, removed: 0 }}
      activeJobId={activeJob?.id ?? null}
      initialRecentJobs={recentJobs}
    />
  )
}
