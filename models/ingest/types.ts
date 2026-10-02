// models/ingest/types.ts
// Zod input schemas and derived TypeScript types for the ingest model.
// No `import "server-only"` — the schema is shared by client-side form
// validation and server-side request parsing.
import { z } from "zod"
import {
  CLUSTER_TERMINAL_STAGE,
  INGEST_STAGE,
  type IngestJob,
  type IngestStage,
  type IngestStatus,
  type PaidOcrEstimate,
} from "./schema"

// ---------------------------------------------------------------------------
// Worker → app wire contracts. These Zod schemas are the SINGLE source of the
// types: lib/cluster/contracts.ts re-exports the inferred types for the
// cluster client and the UI, and no hand-kept copy exists.
// ---------------------------------------------------------------------------

const clusterQueueStageSchema = z.object({
  done: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})

/**
 * Live queue-status read-model returned by the worker's `GET /progress/:runId`
 * (worker-v2 `buildProgress`). Polled by the Ingérer page to render the staged
 * pipeline as it drains — the BnF fetch bucket is the headline bottleneck. A
 * LIVE-UX payload only; NOT the commit signal (that is the terminal
 * ClusterProgressEvent below). Mirror of the worker's ProgressReport.
 */
export const clusterQueueProgressSchema = z.object({
  /** Per-doc status counts (the headline reconciliation), keyed by worker DocStatus. */
  docs: z.record(z.string(), z.number().int().nonnegative()),
  docsTotal: z.number().int().nonnegative(),
  /** Docs fully registered into the index. */
  docsFinished: z.number().int().nonnegative(),
  /** Per-stage bucket counts, keyed by worker stage name (fetch, metadata, …). */
  stages: z.record(z.string(), clusterQueueStageSchema),
  /** Run-scoped BnF-fetch folio tally — `expected` grows as metadata resolves more docs. */
  folios: z.object({
    expected: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  /** Folios from OTHER concurrent runs still pending in the shared BnF-fetch
   *  queue (the work "ahead of you"). Optional: older workers don't send it. */
  foliosAhead: z.number().int().nonnegative().optional(),
  /** The binding BnF fetch rate (folios/min) the ETA assumes. */
  fetchRatePerMin: z.number().nonnegative(),
  /** The IIIF manifest rate (manifests/min) — the metadata lane's binding cap. */
  manifestRatePerMin: z.number().nonnegative(),
  /** Estimated seconds remaining, or null when not computable. */
  etaSeconds: z.number().nonnegative().nullable(),
  /** True iff the doc totals reconcile (a UI guard against under-reporting). */
  reconciles: z.boolean(),
})
export type ClusterQueueStage = z.infer<typeof clusterQueueStageSchema>
export type ClusterQueueProgress = z.infer<typeof clusterQueueProgressSchema>

/**
 * POST /api/internal/ingest/[job_id]/progress body (found bug B2, feedback
 * 2026-09-29 Track B), validated AFTER the HMAC check. `stats` /
 * `partialStats` stay loose records because the V1 and V2 worker shapes
 * differ; IngestService reads `stats.errors[]` through its own tolerant parser
 * (parseErrorEntries).
 */
export const clusterProgressEventSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.enum([
      INGEST_STAGE.EXTRACT,
      INGEST_STAGE.CHUNK,
      INGEST_STAGE.EMBED,
      INGEST_STAGE.INDEX,
    ]),
    fraction: z.number().min(0).max(1),
    counters: z.record(z.string(), z.number()),
  }),
  z.object({
    stage: z.literal(CLUSTER_TERMINAL_STAGE.DONE),
    chunksWritten: z.number().int().nonnegative(),
    stats: z.record(z.string(), z.unknown()),
  }),
  z.object({
    stage: z.literal(CLUSTER_TERMINAL_STAGE.FAILED),
    error: z.string(),
    partialStats: z.record(z.string(), z.unknown()).optional(),
  }),
])
export type ClusterProgressEvent = z.infer<typeof clusterProgressEventSchema>

/** POST /api/internal/ingest/[job_id]/progress — the event was applied. */
export type ProgressCallbackAck = { accepted: true }

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
 * Plain-language delta preview for the Ingérer panel, computed once at page load
 * by {@link IngestService.previewDelta}. The single source of truth for the
 * panel's counts — `already` (documents consultable now), what a run would add /
 * remove, the excluded split (no-text vs not-digitized), and the paid-OCR
 * opt-in context. Crosses to the client as a server-rendered `initial*` snapshot.
 */
export type IngestDeltaPreview = {
  /** Documents currently consultable by the research assistant (indexed). */
  already: number
  added: number
  removed: number
  excluded: number
  /** Excluded docs that are digitized but carry no readable text (SANS_TEXTE). */
  excludedNoText: number
  /** Excluded docs not digitized at the BnF (NON_NUMERISE). */
  excludedNoScan: number
  paidOcr: PaidOcrEstimate
  /**
   * Budget context for the paid-OCR opt-in, so the UI can show the cost against
   * the cap and disable the opt-in when it won't fit. `withinBudget` is the
   * single source of truth the client gates on; the server re-checks on submit.
   */
  paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
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
