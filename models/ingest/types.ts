// models/ingest/types.ts
// Zod input schemas and derived TypeScript types for the ingest model.
// No `import "server-only"` — the schema is shared by client-side form
// validation and server-side request parsing.
import { z } from "zod"
import type { ClusterQueueProgress } from "@/lib/cluster/contracts"
import type {
  IngestJob,
  IngestStage,
  IngestStatus,
  PaidOcrEstimate,
} from "./schema"

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
  "progress" | "callbackSecret" | "paidOcrEstimatedUsd" | "paidOcrActualUsd"
> & {
  progress: number | null
  // Prisma `Decimal` fields, like `progress`, can't cross the RSC boundary —
  // flatten to plain numbers (null when unset).
  paidOcrEstimatedUsd: number | null
  paidOcrActualUsd: number | null
  // Base/target version seqs for the history "v{base} → v{target}" label. Only
  // populated where the loader joined the versions (the Ingérer history); the
  // single-job API serializers leave them undefined.
  baseVersionSeq?: number | null
  targetVersionSeq?: number
}

/**
 * The single-job poll response: the client-safe job view PLUS the worker's live
 * queue-status read-model (`queue`), or null when there is nothing live to show
 * (terminal job, no clusterJobId, fake mode, or the worker is unreachable). The
 * Ingérer page renders the queue-status card from `queue` while the job runs, and
 * reads `status` for the terminal transition. Returned by GET /api/ingest/[job_id].
 */
export type IngestJobStatusView = IngestJobView & {
  queue: ClusterQueueProgress | null
}

/**
 * Convert a Prisma `IngestJob` row into its client-safe {@link IngestJobView}.
 * Call this at every boundary that hands a job to the client (page props, API
 * responses). Strips `callbackSecret` and flattens the `Decimal` progress.
 */
export function serializeIngestJob(job: IngestJob): IngestJobView {
  // Destructure the secret out so it cannot leak; the Decimal fields are rebuilt
  // below as plain numbers (RSC can't serialize Prisma Decimal).
  const {
    callbackSecret: _callbackSecret,
    progress,
    paidOcrEstimatedUsd,
    paidOcrActualUsd,
    ...rest
  } = job
  return {
    ...rest,
    progress: progress === null ? null : Number(progress),
    paidOcrEstimatedUsd:
      paidOcrEstimatedUsd === null ? null : Number(paidOcrEstimatedUsd),
    paidOcrActualUsd:
      paidOcrActualUsd === null ? null : Number(paidOcrActualUsd),
  }
}

/**
 * Body accepted by POST /api/projects/[id]/ingest.
 * `targetVersionSeq` is optional — omit to target the current head.
 * `confirmPaidOcr` opts into the paid fallback OCR (Mistral) of the delta's
 * `sans_texte` documents. WITHOUT it, the ingest runs the regular delta only and
 * those documents are left untouched — they are never sent silently. WITH it,
 * they are folded in (subject to the project budget; over budget → rejected).
 */
export const ingestSubmitSchema = z.object({
  targetVersionSeq: z.number().int().positive().optional(),
  confirmPaidOcr: z.boolean().optional(),
})
export type IngestSubmitInput = z.infer<typeof ingestSubmitSchema>

/**
 * Result of {@link IngestService.submit}.
 *
 *   • `job`             — a job was created (or an in-flight one reused). The
 *                         regular delta always reaches here; paid-OCR docs are
 *                         included only when `confirmPaidOcr` was set and fit.
 *   • `budget_exceeded` — paid OCR was opted into, but committed spend + this
 *                         estimate would exceed the project budget. NOTHING is
 *                         dispatched; the user must drop the opt-in (the regular
 *                         ingest can then run on its own). A server-side backstop
 *                         — the UI disables the opt-in when it won't fit.
 */
export type IngestSubmitOutcome =
  | { kind: "job"; job: IngestJob }
  | {
      kind: "budget_exceeded"
      paidOcr: PaidOcrEstimate
      spentUsd: number
      ceilingUsd: number
    }

/**
 * Client-safe shape of a non-`job` submit outcome (the `job` case is serialized
 * as a bare {@link IngestJobView}, unchanged, so the existing happy path is
 * byte-for-byte identical). The route returns this body verbatim for the
 * paid-OCR cases; the Ingérer client switches on `kind`.
 */
export type IngestSubmitPaidOcrResponse = Exclude<
  IngestSubmitOutcome,
  { kind: "job" }
>

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
