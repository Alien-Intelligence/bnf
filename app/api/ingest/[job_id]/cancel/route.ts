/**
 * POST /api/ingest/[job_id]/cancel
 *
 * Requests cancellation of an in-flight ingestion job. Cancellation is
 * best-effort: IngestService.cancel sets the job to "canceling" and signals
 * the cluster runner. The cluster eventually posts a terminal callback;
 * the job record is finalized at that point.
 *
 * Partial vectors written before cancellation may remain in the index —
 * they are not referenced by project.ingestedVersionId and therefore not
 * surfaced by rag.query. The next successful ingest reconciles them.
 * See playbook/ingestion-jobs.md §"Cancellation".
 *
 * Layer order: withAuth → load job + project → authorize → delegate.
 * No body parsing — the cancel request carries no body.
 */
import { withAuth } from "@/app/api/_middleware"
import { notFound, ok } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestPolicy } from "@/models/ingest/policy"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import type { IngestJob } from "@/models/ingest/schema"

type RouteCtx = { params: Promise<{ job_id: string }> }

export const POST = withAuth(async (_req, user, bouncer, ctx: RouteCtx) => {
  const { job_id } = await ctx.params

  const job = await IngestQueries.get(job_id)
  if (!job) return notFound("Ingestion introuvable")

  const project = await ProjectQueries.get(job.projectId)
  if (!project) return notFound("Projet introuvable")

  await bouncer.with(IngestPolicy).authorize("cancel", project)

  const updated = await IngestService.cancel(job, user)
  return ok<IngestJob>(updated)
})
