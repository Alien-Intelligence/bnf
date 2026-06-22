/**
 * RAG tool definitions for the BnF research agent — three tools over the
 * ingested corpus, all scoped server-side to the project's cluster dataset:
 *
 *   - rag_query          — semantic (vector) search → ARK + folio + char-range
 *                          passages + entryId.
 *   - rag_keyword_search — typo-tolerant keyword search → entry-level hits with
 *                          facet filters (type / lang / source).
 *   - rag_get_text       — selective full-text retrieval by entryId and a
 *                          character range (pull context around a passage).
 *
 * Each tool checks that the project has a committed ingested version before
 * delegating to ClusterRagClient. If not, it returns a structured error so the
 * agent can explain the situation to the user rather than crashing.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import { ClusterRagClient } from "@/lib/cluster/rag"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

const NOT_INGESTED_ERROR =
  "Le corpus n'a pas encore été ingéré. " +
  "Lance l'ingestion depuis l'étape « Ingérer » avant de lancer une recherche."

/** Resolve the project's committed ingested version, or null if none. */
async function ingestedVersionId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { ingestedVersionId: true },
  })
  return project.ingestedVersionId
}

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
    const versionId = await ingestedVersionId(ctx.projectId)
    if (!versionId) {
      return { passages: [], total: 0, error: NOT_INGESTED_ERROR }
    }

    return ClusterRagClient.query({
      projectId: ctx.projectId,
      ingestedVersionId: versionId,
      query: input.query,
      k: input.k,
      filters: input.filters,
    })
  },
})

// ---------------------------------------------------------------------------
// rag_keyword_search
// ---------------------------------------------------------------------------

export const ragKeywordSearchTool = defineTool<
  z.ZodObject<{
    query: z.ZodString
    limit: z.ZodOptional<z.ZodNumber>
    filters: z.ZodOptional<
      z.ZodObject<{
        type: z.ZodOptional<z.ZodString>
        lang: z.ZodOptional<z.ZodString>
        source: z.ZodOptional<z.ZodString>
      }>
    >
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.ragKeywordSearch,
  description:
    "Typo-tolerant keyword search over the ingested corpus. " +
    "Returns entry-level hits with the document's ARK, title, date, score and " +
    "matched snippets. Use this for exact terms, names, or known titles, and " +
    "when you need to FILTER by document type, language or source — filtering " +
    "lives here, not on rag_query. Use the returned entryId with rag_get_text " +
    "to read the surrounding full text. " +
    "Returns an empty hits array (with an error field) when nothing is ingested.",
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .max(500)
      .describe("Keyword query. May be terms, a name, or a title fragment."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of entry hits to return (1–100, default 20)."),
    filters: z
      .object({
        type: z.string().optional().describe("Restrict to this document type (e.g. \"press\", \"book\")."),
        lang: z.string().optional().describe("Restrict to this language code (e.g. \"fr\")."),
        source: z.string().optional().describe("Restrict to this source (e.g. \"gallica\")."),
      })
      .optional()
      .describe("Exact-match facet filters applied before ranking."),
  }),
  handler: async (input, ctx) => {
    const versionId = await ingestedVersionId(ctx.projectId)
    if (!versionId) {
      return { hits: [], total: 0, error: NOT_INGESTED_ERROR }
    }

    return ClusterRagClient.keywordSearch({
      projectId: ctx.projectId,
      ingestedVersionId: versionId,
      query: input.query,
      limit: input.limit,
      filters: input.filters,
    })
  },
})

// ---------------------------------------------------------------------------
// rag_get_text
// ---------------------------------------------------------------------------

export const ragGetTextTool = defineTool<
  z.ZodObject<{
    entryId: z.ZodNumber
    charOffset: z.ZodOptional<z.ZodNumber>
    charLimit: z.ZodOptional<z.ZodNumber>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.ragGetText,
  description:
    "Retrieve the processed full text of a corpus entry, selectively, by " +
    "character range. Pass the entryId from a rag_query or rag_keyword_search " +
    "result, and use a passage's char range to pull the surrounding context " +
    "(e.g. charOffset slightly before its start). charLimit 0 returns the rest " +
    "of the document; keep slices to a few thousand characters. Returns text, " +
    "totalLength, hasMore and nextOffset for pagination.",
  inputSchema: z.object({
    entryId: z
      .number()
      .int()
      .describe("Cluster entry id, taken verbatim from a search result. Never invented."),
    charOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Start offset into the processed text (default 0)."),
    charLimit: z
      .number()
      .int()
      .min(0)
      .max(20000)
      .optional()
      .describe("Characters to return; 0 = the rest of the document (default 4000)."),
  }),
  handler: async (input, ctx) => {
    const versionId = await ingestedVersionId(ctx.projectId)
    if (!versionId) {
      return { text: "", error: NOT_INGESTED_ERROR }
    }

    return ClusterRagClient.getEntryContent({
      projectId: ctx.projectId,
      entryId: input.entryId,
      charOffset: input.charOffset,
      charLimit: input.charLimit,
    })
  },
})

// Convenience array for the registry builder.
export const ragTools = [ragQueryTool, ragKeywordSearchTool, ragGetTextTool] as const
