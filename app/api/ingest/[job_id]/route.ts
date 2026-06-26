/**
 * GET /api/ingest/[job_id]
 *
 * Returns the current snapshot of an IngestJob PLUS the worker's live
 * queue-status read-model (`queue`) so the Ingérer page can render the staged
 * pipeline as it drains. Polled while the job is non-terminal; the client's
 * useIngestStatus hook stops refetching once status reaches a terminal state.
 *
 * The `queue` payload is best-effort live UX, proxied from the worker via
 * IngestService.queueProgress (null in fake mode / terminal / worker down). The
 * version commit never depends on it — that rides the HMAC terminal callback.
 *
 * Layer order: withAuth → load job + project → authorize → service → respond.
 * No body parsing — GET has no body.
 *
 * See playbook/ingestion-jobs.md §"Progress reporting".
 */
import { withAuth } from "@/app/api/_middleware"
import { notFound, ok } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestPolicy } from "@/models/ingest/policy"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import {
  serializeIngestJob,
  type IngestJobStatusView,
} from "@/models/ingest/types"

type RouteCtx = { params: Promise<{ job_id: string }> }

export const GET = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { job_id } = await ctx.params

  const job = await IngestQueries.get(job_id)
  if (!job) return notFound("Ingestion introuvable")

  // Load the parent project so IngestPolicy can authorize against it.
  const project = await ProjectQueries.get(job.projectId)
  if (!project) return notFound("Projet introuvable")

  await bouncer.with(IngestPolicy).authorize("view", project)

  const queue = await IngestService.queueProgress(job)
  return ok<IngestJobStatusView>({ ...serializeIngestJob(job), queue })
})
