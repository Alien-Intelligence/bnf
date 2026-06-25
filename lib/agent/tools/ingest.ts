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
      // The agent never authorizes paid OCR on its own — confirming the spend is
      // a human decision made in the Ingérer UI. We submit WITHOUT confirmPaidOcr,
      // so a delta that needs paid OCR comes back as a non-`job` outcome we relay
      // to the librarian instead of silently spending money.
      const outcome = await IngestService.submit(project, ctx.user, {
        targetVersionSeq: input.target_version,
      })
      if (outcome.kind === "confirmation_required") {
        return {
          status: "paid_ocr_confirmation_required",
          message:
            `${outcome.paidOcr.docCount} document(s) numérisé(s) sans OCR ` +
            `nécessitent une transcription payante (≈ ${outcome.paidOcr.usd.toFixed(2)} $). ` +
            `Demandez à la·au bibliothécaire de confirmer dans l'étape Ingérer.`,
          paid_ocr_docs: outcome.paidOcr.docCount,
          estimated_usd: outcome.paidOcr.usd,
        }
      }
      if (outcome.kind === "budget_exceeded") {
        return {
          status: "paid_ocr_budget_exceeded",
          message:
            `La transcription payante (≈ ${outcome.paidOcr.usd.toFixed(2)} $) dépasserait ` +
            `le budget OCR du projet (dépensé ${outcome.spentUsd.toFixed(2)} $ / ` +
            `plafond ${outcome.ceilingUsd.toFixed(2)} $).`,
          estimated_usd: outcome.paidOcr.usd,
        }
      }
      const job = outcome.job
      ctx.emit?.({
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
