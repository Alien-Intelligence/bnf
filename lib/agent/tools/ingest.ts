import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import type { TurnScopedCtx } from "./registry-factory"
import { emitDomainEvent, STREAM_DOMAIN_EVENT } from "@/lib/agent/stream-events"
import { AGENT_TOOLS } from "./constants"
import { IngestPolicy } from "@/models/ingest/policy"
import { IngestService } from "@/models/ingest/service"
import { authorizeProjectTool } from "./authorize"
import { toolFailure } from "./failure"

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
    "`added_count` / `removed_count` are null until the job has computed its delta. " +
    "Call this only after the librarian has confirmed the corpus is ready to ingest.",
  inputSchema,
  handler: async (input, ctx) => {
    const gate = await authorizeProjectTool(ctx, IngestPolicy, "submit")
    if (!gate.ok) return gate.result
    const project = gate.project
    try {
      // The agent ingests the REGULAR delta only — it never opts into paid OCR
      // (confirmPaidOcr stays unset), so the `sans_texte` docs are left untouched
      // and no money is spent on the agent's behalf. Paid OCR is a deliberate
      // human action in the Ingérer UI. submit() therefore always returns a job.
      const outcome = await IngestService.submit(project, ctx.user, {
        targetVersionSeq: input.target_version,
      })
      // Defensive: submit() only returns non-`job` when confirmPaidOcr was set,
      // which we never do — but never silently swallow an unexpected outcome.
      if (outcome.kind !== "job") {
        console.error(`[ingest_submit] unexpected submit outcome: ${outcome.kind}`)
        return toolFailure(`L'ingestion n'a pas été lancée (issue inattendue : ${outcome.kind}).`)
      }
      const job = outcome.job
      emitDomainEvent(ctx, {
        type: STREAM_DOMAIN_EVENT.INGEST,
        data: { kind: "submitted", jobId: job.id, status: job.status },
      })
      return {
        job_id: job.id,
        status: job.status,
        added_count: job.addedCount,
        removed_count: job.removedCount,
      }
    } catch (err) {
      // A tool never throws out of the loop (CLAUDE_ERROR_PATTERNS §15): the
      // failure is logged here and handed to the model as a structured result.
      const message = err instanceof Error ? err.message : String(err)
      console.error("[ingest_submit] submit failed:", err)
      return toolFailure(`L'ingestion n'a pas pu être lancée : ${message}`)
    }
  },
})

export const ingestTools = [ingestSubmitTool] as const
