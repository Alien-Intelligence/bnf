/**
 * POST /api/internal/ingest/[job_id]/progress
 *
 * Cluster callback endpoint. Called by the cluster's ingest worker (not by
 * the browser) to report stage transitions, per-stage fraction, counters, and
 * final result or failure. IngestService.applyProgress persists each event and
 * publishes it to IngestPubSub so the SSE stream and polling clients see it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONE ROUTE IN THE APP THAT IS NOT BEHIND withAuth.
 * Authentication here is HMAC over the raw request body using a per-job
 * shared secret generated at submit time and stored in ingest_job.callbackSecret.
 * The signature is delivered in the x-callback-signature header.
 * See: implementation plan §9 and lib/cluster/callback-auth.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Intentionally NOT using withAuth because:
 *  1. The cluster has no user session — it is a machine caller.
 *  2. Bearer tokens would require the cluster to know the app's auth system.
 *  3. HMAC with a per-job secret is standard practice for webhook callbacks
 *     (Stripe, GitHub, etc.) and provides replay protection when combined
 *     with a timestamp claim in the body.
 *
 * Security properties:
 *  - The secret is generated per-job with crypto.randomBytes(32) in IngestService.submit.
 *  - Verification is constant-time (crypto.timingSafeEqual inside verifyCallback).
 *  - An unknown job, a job without a callbackSecret and a bad signature take
 *    ONE path: the body is read and verified (against a per-process secret no
 *    caller knows when the job has none — verifyJobCallback) and all three
 *    answer the same 401 message, so the endpoint reveals neither which job
 *    ids exist nor how they were submitted, by its answer or its timing.
 *  - Malformed JSON after a valid HMAC is rejected with 400; the cluster must fix its payload.
 *  - So is a well-formed body that is not a ClusterProgressEvent
 *    (clusterProgressEventSchema, found bug B2): 400 with the Zod issues. The
 *    HMAC is still verified first, over the raw bytes, before anything is parsed.
 *
 * See playbook/ingestion-jobs.md §"The cluster ingest script contract".
 */
import { badRequest, ok, unauthorized } from "@/lib/api-response"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import {
  clusterProgressEventSchema,
  type ProgressCallbackAck,
} from "@/models/ingest/types"
import { CALLBACK_REJECTED_MESSAGE, verifyJobCallback } from "@/lib/cluster/callback-auth"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ job_id: string }> },
): Promise<Response> {
  const { job_id } = await ctx.params

  const job = await IngestQueries.get(job_id)

  // Read the body as text so we can verify the HMAC over the exact bytes the
  // cluster signed — parsing before verification would allow canonicalization
  // attacks. Read and verified whatever the job: an unknown job or one without
  // a callbackSecret (never submitted through IngestService.submit, or
  // corrupted) takes the same path and gets the same answer as a bad signature.
  const bodyText = await req.text()
  const signature = req.headers.get("x-callback-signature")
  const verified = verifyJobCallback(bodyText, signature, job === null ? null : job.callbackSecret)
  if (job === null || !verified) return unauthorized(CALLBACK_REJECTED_MESSAGE)

  // Body was signed correctly but is not valid JSON / not a progress event —
  // a cluster bug, not ours: refuse it before anything is written.
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    return badRequest("invalid JSON")
  }
  const event = clusterProgressEventSchema.safeParse(raw)
  if (!event.success) return badRequest("invalid event", event.error.issues)

  // A `done` event commits the version AND (inside IngestService) requests a
  // fresh OCR-quality pull for the run's documents.
  await IngestService.applyProgress(job, event.data)
  return ok<ProgressCallbackAck>({ accepted: true })
}
