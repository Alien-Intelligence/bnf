/**
 * POST /api/projects/[id]/ingest
 *
 * Submit an ingestion job for the given project. The job is asynchronous:
 * this endpoint returns immediately with the created (or deduplicated) job row.
 * The client polls GET /api/ingest/:job_id or subscribes to the SSE stream.
 *
 * Layer order: withAuth → parseBody → load project → authorize → delegate
 * to IngestService.submit (all business logic lives there).
 *
 * See playbook/ingestion-jobs.md for the full job lifecycle.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestPolicy } from "@/models/ingest/policy"
import { IngestService } from "@/models/ingest/service"
import { ingestSubmitSchema } from "@/models/ingest/types"
import type { IngestJob } from "@/models/ingest/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params

  const parsed = await parseBody(req, ingestSubmitSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")

  await bouncer.with(IngestPolicy).authorize("submit", project)

  const job = await IngestService.submit(project, user, parsed)
  return ok<IngestJob>(job)
})
