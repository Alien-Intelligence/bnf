// models/ingest/schema.ts
// Domain enums and re-exported Prisma types for the IngestJob model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { IngestJob, Prisma } from "@/lib/generated/prisma/client"
import {
  PAID_OCR_MAX_PAGES_PER_DOC,
  PAID_OCR_USD_PER_1K_PAGES,
} from "@/lib/constants"

export const INGEST_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  // PARTIAL — most docs indexed, at least one failed. The successes ARE in the
  // index (their Document.indexedAt is stamped, so they drop out of the delta);
  // only the failed docs remain to ingest. Distinct from FAILED (nothing usable
  // committed) so the UI can show "N indexed / M failed" instead of "Échec".
  PARTIAL: "partial",
  FAILED: "failed",
  CANCELED: "canceled",
} as const
export type IngestStatus = (typeof INGEST_STATUS)[keyof typeof INGEST_STATUS]

/** Narrows a status read from the database (a plain string column) to {@link IngestStatus}. */
export function isIngestStatus(value: string): value is IngestStatus {
  return (Object.values(INGEST_STATUS) as string[]).includes(value)
}

export const INGEST_STAGE = {
  EXTRACT: "extract",
  CHUNK: "chunk",
  EMBED: "embed",
  INDEX: "index",
} as const
export type IngestStage = (typeof INGEST_STAGE)[keyof typeof INGEST_STAGE]

/**
 * The two TERMINAL `stage` values of a cluster progress callback event (the
 * running events carry an IngestStage). `done` commits the version (fully or
 * partially), `failed` leaves the ingested pointer where it was.
 */
export const CLUSTER_TERMINAL_STAGE = {
  DONE: "done",
  FAILED: "failed",
} as const
export type ClusterTerminalStage =
  (typeof CLUSTER_TERMINAL_STAGE)[keyof typeof CLUSTER_TERMINAL_STAGE]

/** The outcomes of one poll of the worker's read-model (ClusterClient.progress). */
export const CLUSTER_POLL = {
  PROGRESS: "progress",
  /** 404: the worker does not know this run (pruned, or never seeded). */
  RUN_UNKNOWN: "run_unknown",
  /** No answer at all (transport error, timeout). */
  WORKER_UNREACHABLE: "worker_unreachable",
  /** The worker answered with a non-2xx other than 404. */
  WORKER_ERROR: "worker_error",
} as const
export type ClusterPoll = (typeof CLUSTER_POLL)[keyof typeof CLUSTER_POLL]

/** Cost estimate for transcribing a set of `sans_texte` documents via paid OCR. */
export interface PaidOcrEstimate {
  /** Number of `sans_texte` documents the estimate covers. */
  docCount: number
  /** Total folios to transcribe, after holding unknown counts at the per-doc cap. */
  pages: number
  /** Estimated USD cost at the Mistral OCR Batch rate. */
  usd: number
}

/**
 * Estimate the paid-OCR cost for a list of documents from their page counts.
 *
 * A null/zero/absent page count (an unresolved stub, or a fascicule whose folio
 * count is not known) is held at {@link PAID_OCR_MAX_PAGES_PER_DOC}, the most
 * the worker will ever transcribe for one document; every document is capped at
 * that same value (the worker drops folios beyond it). The result is therefore
 * an upper bound shown at the confirmation prompt, and the confirmed estimate is
 * what the project is charged at commit. Pure; safe on both client and server.
 */
export function estimatePaidOcrCostUsd(
  pageCounts: ReadonlyArray<number | null | undefined>,
): PaidOcrEstimate {
  const pages = pageCounts.reduce<number>((sum, p) => {
    const count = typeof p === "number" && p > 0 ? p : PAID_OCR_MAX_PAGES_PER_DOC
    return sum + Math.min(count, PAID_OCR_MAX_PAGES_PER_DOC)
  }, 0)
  return {
    docCount: pageCounts.length,
    pages,
    usd: (pages / 1000) * PAID_OCR_USD_PER_1K_PAGES,
  }
}

export type { IngestJob }

/** Query shape: a job with its base/target version seqs joined (for the history, "v10 → v15"). */
export const ingestJobWithVersions = {
  include: {
    targetVersion: { select: { seq: true } },
    baseVersion: { select: { seq: true } },
  },
} satisfies Prisma.IngestJobDefaultArgs
export type IngestJobWithVersions = Prisma.IngestJobGetPayload<typeof ingestJobWithVersions>

/** The statuses of a job that is still in flight (the soft-uniqueness set). */
export const INGEST_ACTIVE_STATUSES = [INGEST_STATUS.QUEUED, INGEST_STATUS.RUNNING] as const

// ---------------------------------------------------------------------------
// Admin console — OCR / ingestion usage.
// Read-only DTOs for the admin "OCR" tab. Only PAID OCR (Mistral) carries a
// tracked USD cost; the vision/describe (OpenRouter) and embed (RunPod) steps
// record no per-call cost, so this view is scoped to paid-OCR spend + ingest
// volume. Dates are ISO strings (JSON transport); Decimals become numbers.
// ---------------------------------------------------------------------------

/** Cumulative paid-OCR spend for one project. */
export type AdminOcrProjectStat = {
  projectId: string
  projectName: string
  ownerEmail: string
  spentUsd: number
  budgetUsd: number | null
  paidJobCount: number
  paidOcrDocs: number
}

/** One ingest job that involved paid OCR. */
export type AdminOcrJobStat = {
  id: string
  projectId: string
  projectName: string
  status: string
  createdAt: string
  finishedAt: string | null
  paidOcrDocs: number
  estimatedUsd: number | null
  actualUsd: number | null
  chunksWritten: number | null
}

/** Full admin OCR-usage report. */
export type AdminOcrUsage = {
  totals: {
    spentUsd: number
    paidJobs: number
    paidOcrDocs: number
    /** Pages transcribed, derived from spend at the fixed per-1k-page rate. */
    pagesApprox: number
  }
  projects: AdminOcrProjectStat[]
  recentJobs: AdminOcrJobStat[]
}
