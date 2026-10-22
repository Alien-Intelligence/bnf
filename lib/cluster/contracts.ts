// lib/cluster/contracts.ts
// Pure types shared between this app and the cluster team.
// No runtime code — safe to import on both client and server.

export interface ClusterDoc {
  ark: string
  title: string
  year: number | null
  docType: string
  /** Gallica typedoc subcategory ("fascicules", "titres", "plan", …), derived
   *  app-side from the OAI `gallica_typedoc`; null when absent. The worker
   *  forwards it as-is into the index metadata (it fetches nothing itself and
   *  does not use it for lane routing). */
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

import type { CLUSTER_POLL } from "@/models/ingest/schema"
import type { ClusterQueueProgress as QueueProgress } from "@/models/ingest/types"

// The worker → app wire contracts are Zod schemas in models/ingest/types.ts —
// the single source; their inferred types are re-exported here for the
// cluster client and the UI.
export type {
  ClusterProgressEvent,
  ClusterQueueProgress,
  ClusterQueueStage,
} from "@/models/ingest/types"

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
