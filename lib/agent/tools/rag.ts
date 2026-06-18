/**
 * RAG tool definitions for the BnF research agent.
 *
 * One tool:
 *   - rag_query — semantic similarity search over the ingested corpus,
 *                 returning passages with ARK, folio, snippet, and score.
 *
 * The tool checks that the project has a committed ingested version before
 * delegating to ClusterRagClient. If not, it returns a structured error so
 * the agent can explain the situation to the user rather than crashing.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import { ClusterRagClient } from "@/lib/cluster/rag"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// rag_query
// ---------------------------------------------------------------------------

export const ragQueryTool = defineTool<
  z.ZodObject<{
    query: z.ZodString
    k: z.ZodOptional<z.ZodNumber>
    filters: z.ZodOptional<
      z.ZodObject<{
        type: z.ZodOptional<z.ZodArray<z.ZodString>>
        lang: z.ZodOptional<z.ZodArray<z.ZodString>>
        source: z.ZodOptional<z.ZodArray<z.ZodString>>
        yearFrom: z.ZodOptional<z.ZodNumber>
        yearTo: z.ZodOptional<z.ZodNumber>
      }>
    >
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.ragQuery,
  description:
    "Search the ingested corpus by semantic similarity. " +
    "Returns passages with ARK, folio, snippet, and relevance score. " +
    "Use focused, specific queries — one concept per call — rather than broad questions. " +
    "Apply filters (type, lang, source, yearFrom/yearTo) when the question is scoped. " +
    "Returns an empty passages array when no ingestion has been committed — " +
    "the error field will explain the situation.",
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe("The semantic search query. One focused concept per call."),
    k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Number of passages to retrieve (1–50, default decided by the cluster)."),
    filters: z
      .object({
        type: z.array(z.string()).optional().describe("Restrict to these document types."),
        lang: z.array(z.string()).optional().describe("Restrict to these language codes."),
        source: z.array(z.string()).optional().describe("Restrict to these source identifiers."),
        yearFrom: z.number().int().optional().describe("Earliest publication year (inclusive)."),
        yearTo: z.number().int().optional().describe("Latest publication year (inclusive)."),
      })
      .optional()
      .describe("Optional filters to narrow the search scope."),
  }),
  handler: async (input, ctx) => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: ctx.projectId },
      select: { ingestedVersionId: true },
    })

    if (!project.ingestedVersionId) {
      return {
        passages: [],
        total: 0,
        error:
          "Le corpus n'a pas encore été ingéré. " +
          "Lance l'ingestion depuis l'étape « Ingérer » avant de lancer une recherche.",
      }
    }

    return ClusterRagClient.query({
      projectId: ctx.projectId,
      ingestedVersionId: project.ingestedVersionId,
      query: input.query,
      k: input.k,
      filters: input.filters,
    })
  },
})

// Convenience array for the registry builder.
export const ragTools = [ragQueryTool] as const
