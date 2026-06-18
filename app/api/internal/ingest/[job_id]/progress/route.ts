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
 *  - A missing or blank callbackSecret on the job row is rejected with 401.
 *  - Malformed JSON after a valid HMAC is rejected with 400; the cluster must fix its payload.
 *
 * See playbook/ingestion-jobs.md §"The cluster ingest script contract".
 */
import { ok, notFound, unauthorized } from "@/lib/api-response"
import { IngestQueries } from "@/models/ingest/queries"
import { IngestService } from "@/models/ingest/service"
import { verifyCallback } from "@/lib/cluster/callback-auth"
import type { ClusterProgressEvent } from "@/lib/cluster/contracts"

export async function POST(
  req: Request,
  ctx: { params: Promise<{ job_id: string }> },
): Promise<Response> {
  const { job_id } = await ctx.params

  const job = await IngestQueries.get(job_id)
  if (!job) return notFound()

  // A job without a callbackSecret was never submitted through IngestService.submit
  // (or was corrupted). Reject rather than silently accept.
  if (!job.callbackSecret) return unauthorized("no callback secret")

  // Read the body as text so we can verify the HMAC over the exact bytes the
  // cluster signed — parsing before verification would allow canonicalization attacks.
  const bodyText = await req.text()

  if (
    !verifyCallback(
      bodyText,
      req.headers.get("x-callback-signature"),
      job.callbackSecret,
    )
  ) {
    return unauthorized("invalid callback signature")
  }

  let event: ClusterProgressEvent
  try {
    event = JSON.parse(bodyText) as ClusterProgressEvent
  } catch {
    // Body was signed correctly but is not valid JSON — cluster bug, not ours.
    return ok({ accepted: false }, 400)
  }

  await IngestService.applyProgress(job, event)
  return ok({ accepted: true })
}
