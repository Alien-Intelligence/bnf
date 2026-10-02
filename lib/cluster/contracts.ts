// lib/cluster/contracts.ts
// Pure types shared between this app and the cluster team.
// No runtime code — safe to import on both client and server.

export interface ClusterDoc {
  ark: string
  title: string
  year: number | null
  docType: string
  /** Gallica typedoc subcategory ("fascicules", "titres", "plan", …); null when
   *  absent. Indexed into the datacluster as a filterable metadata field. */
  subtype: string | null
  lang: string | null
  source: string
  iiifManifestUrl: string | null
}

export interface ClusterIngestRequest {
  projectId: string
  targetVersionId: string
  /**
   * The app-side IngestJob id. Carried explicitly on the wire so the cluster
   * worker does not need to parse it out of callbackUrl. Both sides of the
   * contract own this field.
   */
  appJobId: string
  added: ClusterDoc[]
  removed: string[]
  callbackUrl: string
  callbackSecret: string
}

import type { ClusterQueueProgress as QueueProgress } from "@/models/ingest/types"

// The worker → app wire contracts are Zod schemas in models/ingest/types.ts —
// the single source; their inferred types are re-exported here for the
// cluster client and the UI.
export type {
  ClusterProgressEvent,
  ClusterQueueProgress,
  ClusterQueueStage,
} from "@/models/ingest/types"

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

export type ClusterProgressPoll =
  | { kind: typeof CLUSTER_POLL.PROGRESS; progress: QueueProgress }
  | { kind: typeof CLUSTER_POLL.RUN_UNKNOWN }
  | { kind: typeof CLUSTER_POLL.WORKER_UNREACHABLE; detail: string }
  | { kind: typeof CLUSTER_POLL.WORKER_ERROR; status: number }

/**
 * One entry in a terminal event's `stats.errors[]` (worker-v2's
 * TerminalStats). `stats` itself stays a loose `Record<string, unknown>`
 * below (V1/V2 shapes differ), but `errors[]` entries follow this shape once
 * parsed.
 *
 * `warning: true` marks a doc that still SUCCEEDED — status `done`,
 * `indexedAt` set — but lost pages to the worker's OCR honesty drop (F13,
 * ai-memories/tech/repos/bnf/ingest-hardening: Mistral OCR hallucinating on
 * dense newspaper scans). It is NEVER a per-doc failure: `IngestService.
 * applyProgress`/`commit`/`commitPartialFailure` must annotate `Document.
 * indexError` for these ARKs without clearing `indexedAt`, and must not count
 * them toward a job's failed-doc total.
 */
export interface ClusterProgressErrorEntry {
  ark: string
  stage: string
  reason: string
  warning?: true
}
