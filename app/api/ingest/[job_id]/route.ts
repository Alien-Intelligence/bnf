/**
 * GET /api/ingest/[job_id]
 *
 * Returns the current snapshot of an IngestJob. Used for polling while the
 * job is in a non-terminal state (queued | running). The client's
 * useIngestStatus hook stops refetching once status reaches done/failed/canceled.
 *
 * Layer order: withAuth → load job + project → authorize → respond.
 * No body parsing — GET has no body.
 *
 * See playbook/ingestion-jobs.md §"Progress reporting".
 */
import { withAuth } from "@/app/api/_middleware"
import { notFound, ok } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestPolicy } from "@/models/ingest/policy"
import { IngestQueries } from "@/models/ingest/queries"
import { serializeIngestJob, type IngestJobView } from "@/models/ingest/types"

type RouteCtx = { params: Promise<{ job_id: string }> }

export const GET = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { job_id } = await ctx.params

  const job = await IngestQueries.get(job_id)
  if (!job) return notFound("Ingestion introuvable")

  // Load the parent project so IngestPolicy can authorize against it.
  const project = await ProjectQueries.get(job.projectId)
  if (!project) return notFound("Projet introuvable")

  await bouncer.with(IngestPolicy).authorize("view", project)

  return ok<IngestJobView>(serializeIngestJob(job))
})
