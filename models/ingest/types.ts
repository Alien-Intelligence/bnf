// models/ingest/types.ts
// Zod input schemas and derived TypeScript types for the ingest model.
// No `import "server-only"` — the schema is shared by client-side form
// validation and server-side request parsing.
import { z } from "zod"
import type { IngestStage, IngestStatus } from "./schema"

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
