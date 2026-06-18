import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"
import { ProjectQueries } from "@/models/projects/queries"
import { IngestService } from "@/models/ingest/service"

const inputSchema = z.object({
  target_version: z.number().int().positive().optional().describe(
    "Optional corpus version sequence to ingest. Defaults to the current head version.",
  ),
})

export const ingestSubmitTool = defineTool<typeof inputSchema, TurnScopedCtx>({
  name: AGENT_TOOLS.ingestSubmit,
  description:
    "Submit an ingestion job for the head corpus version. " +
    "Processing is asynchronous (extract → chunk → embed → index). " +
    "Returns the job id immediately — the user can navigate away and check progress later. " +
    "Call this only after the librarian has confirmed the corpus is ready to ingest.",
  inputSchema,
  handler: async (input, ctx) => {
    const project = await ProjectQueries.get(ctx.projectId)
    if (!project) return { error: "project_not_found" }
    try {
      const job = await IngestService.submit(project, ctx.user, {
        targetVersionSeq: input.target_version,
      })
      ctx.pubsub.publish(ctx.turnId, {
        type: "ingest_event",
        data: { kind: "submitted", jobId: job.id, status: job.status },
      })
      return {
        job_id: job.id,
        status: job.status,
        added_count: job.addedCount ?? 0,
        removed_count: job.removedCount ?? 0,
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : "ingest_failed" }
    }
  },
})

export const ingestTools = [ingestSubmitTool] as const
