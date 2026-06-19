/**
 * POST /api/ingest/[job_id]/retry-failed
 *
 * Submits a new ingest job for the documents that failed in a previous job.
 * The failed ARK list is read from `stats.errors` on the source job.
 *
 * Returns 200 with the new IngestJob when at least one failure is found.
 * Returns 409 when the source job has no recorded per-document failures.
 *
 * Layer order: withAuth → load job + project → authorize → delegate → respond.
 * No request body — the failed ARK list is derived server-side from job state.
 *
 * See playbook/ingestion-jobs.md §"Retry failed documents".
 */
import { withAuth } from "@/app/api/_middleware"
import { notFound, conflict, ok } from "@/lib/api-response"
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

  await bouncer.with(IngestPolicy).authorize("submit", project)

  const result = await IngestService.retryFailed(job_id, user)

  if (!("id" in result)) {
    return conflict("Aucun document en échec à réessayer")
  }

  return ok<IngestJob>(result)
})
