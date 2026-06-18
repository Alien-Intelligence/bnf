/**
 * Ingestion tool stub.
 *
 * `ingest_submit` will trigger the async ingestion job (extract → chunk →
 * embed → index) for the current corpus version delta. The full implementation
 * lands in the ingestion slice — this stub lets the corpus agent declare the
 * tool so the model's tool list is stable across slices.
 *
 * The stub returns a structured "not-implemented" payload rather than an error
 * so the agent can communicate this limitation gracefully to the librarian in
 * French.
 *
 * See playbook/ingestion-jobs.md for the full contract.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

export const ingestSubmitTool = defineTool<z.ZodObject<Record<never, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.ingestSubmit,
  description:
    "Submit the current corpus delta for asynchronous ingestion into the RAG store. " +
    "Ingestion runs in four stages: extract → chunk → embed → index. " +
    "The job is fire-and-forget — the user can close the tab and come back later. " +
    "Call this only after the librarian has confirmed the corpus is ready to ingest.",
  inputSchema: z.object({}),
  handler: async () => ({
    status:  "not-implemented",
    message: "Ingestion arrive dans la prochaine itération.",
  }),
})

export const ingestTools = [ingestSubmitTool] as const
