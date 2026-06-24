// models/ingest/types.ts
// Zod input schemas and derived TypeScript types for the ingest model.
// No `import "server-only"` — the schema is shared by client-side form
// validation and server-side request parsing.
import { z } from "zod"
import type { IngestJob, IngestStage, IngestStatus } from "./schema"

/**
 * Client-safe shape of an IngestJob — the only ingest-job type that may cross
 * the server→client boundary (server-component props or API JSON).
 *
 * Two reasons the raw Prisma row can't cross as-is:
 *   1. `progress` is a Prisma `Decimal`, which React Server Components refuse
 *      to serialize ("Only plain objects can be passed to Client Components").
 *      We coerce it to a plain `number | null`.
 *   2. `callbackSecret` is the per-job HMAC secret the cluster uses to sign
 *      progress webhooks. It must NEVER reach the browser — it is dropped here.
 */
export type IngestJobView = Omit<
  IngestJob,
  "progress" | "callbackSecret"
> & {
  progress: number | null
}

/**
 * Convert a Prisma `IngestJob` row into its client-safe {@link IngestJobView}.
 * Call this at every boundary that hands a job to the client (page props, API
 * responses). Strips `callbackSecret` and flattens the `Decimal` progress.
 */
export function serializeIngestJob(job: IngestJob): IngestJobView {
  // Destructure the secret out so it cannot leak; `progress` is rebuilt below.
  const { callbackSecret: _callbackSecret, progress, ...rest } = job
  return {
    ...rest,
    progress: progress === null ? null : Number(progress),
  }
}

/**
 * Body accepted by POST /api/projects/[id]/ingest.
 * `targetVersionSeq` is optional — omit to target the current head.
 */
export const ingestSubmitSchema = z.object({
  targetVersionSeq: z.number().int().positive().optional(),
})
export type IngestSubmitInput = z.infer<typeof ingestSubmitSchema>

/**
 * Poll response returned by GET /api/ingest/[job_id].
 * The `stages` array always has four entries in fixed order so the UI renders
 * all four rows even when some are still pending.
 */
export type IngestStatusResponse = {
  status: IngestStatus
  stage: IngestStage | null
  progress: number
  addedCount: number
  removedCount: number
  chunksWritten: number
  etaSeconds: number | null
  stages: {
    key: IngestStage
    status: "pending" | "running" | "done" | "failed"
    fraction: number
  }[]
  error: string | null
}

/**
 * Results object passed to IngestService.commit() when the cluster signals done.
 */
export type IngestResults = {
  chunksWritten: number
  stats: Record<string, unknown>
}
