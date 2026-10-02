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
import { ClusterRagClient } from "@/lib/cluster/rag"
import {
  RAG_DEFAULT_K,
  RAG_GET_TEXT_DEFAULT_CHAR_LIMIT,
  RAG_GET_TEXT_MAX_CHAR_LIMIT,
  RAG_KEYWORD_DEFAULT_LIMIT,
  RAG_KEYWORD_MAX_LIMIT,
  RAG_QUERY_MAX_CHARS,
  RAG_QUERY_MAX_K,
  RAG_QUERY_MIN_CHARS,
} from "@/lib/constants"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"
import { refusal } from "./refusal"
import { NOT_INGESTED_ERROR, resolveIngestedCorpus } from "./ingestion-guard"

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
    "Semantic search CANNOT filter: `filters` are not applied (the result lists them in " +
    "ignoredFilters). To filter by type, language or source, use rag_keyword_search. " +
    "Refuses (success: false, with an error explaining why) when no ingestion has " +
    "been committed.",
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(RAG_QUERY_MIN_CHARS)
      .max(RAG_QUERY_MAX_CHARS)
      .describe("The semantic search query. One focused concept per call."),
    k: z
      .number()
      .int()
      .min(1)
      .max(RAG_QUERY_MAX_K)
      .optional()
      .describe(`Number of passages to retrieve (1–${RAG_QUERY_MAX_K}, default ${RAG_DEFAULT_K}).`),
    filters: z
      .object({
        type: z.array(z.string()).optional().describe("Restrict to these document types."),
        lang: z.array(z.string()).optional().describe("Restrict to these language codes."),
        source: z.array(z.string()).optional().describe("Restrict to these source identifiers."),
        yearFrom: z.number().int().optional().describe("Earliest publication year (inclusive)."),
        yearTo: z.number().int().optional().describe("Latest publication year (inclusive)."),
      })
      .optional()
      .describe(
        "NOT APPLIED by semantic search — accepted only so a call that passes them is not " +
          "rejected; they come back in ignoredFilters. Filter with rag_keyword_search instead.",
      ),
  }),
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
    if ("error" in corpus) {
      return refusal(corpus.error)
    }

    const result = await ClusterRagClient.query({
      projectId: ctx.corpusProjectId,
      query: input.query,
      k: input.k ?? RAG_DEFAULT_K,
      signal: ctx.signal,
    })
    // The cluster's vector search filters by dataset / entry / score only:
    // say which requested filters had no effect rather than imply they did.
    const ignoredFilters = Object.entries(input.filters ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name)
    return ignoredFilters.length > 0 ? { ...result, ignoredFilters } : result
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
    "Refuses (success: false, with an error) when nothing is ingested.",
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .max(RAG_QUERY_MAX_CHARS)
      .describe("Keyword query. May be terms, a name, or a title fragment."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(RAG_KEYWORD_MAX_LIMIT)
      .optional()
      .describe(
        `Maximum number of entry hits to return (1–${RAG_KEYWORD_MAX_LIMIT}, default ${RAG_KEYWORD_DEFAULT_LIMIT}).`,
      ),
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
    const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
    if ("error" in corpus) {
      return refusal(corpus.error)
    }

    return ClusterRagClient.keywordSearch({
      projectId: ctx.corpusProjectId,
      query: input.query,
      limit: input.limit ?? RAG_KEYWORD_DEFAULT_LIMIT,
      filters: input.filters,
      signal: ctx.signal,
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
    "result and, when the passage carries one (charRange is null for documents " +
    "indexed before offsets existed), use its char range to pull the surrounding " +
    "context (e.g. charOffset slightly before its start). charLimit 0 returns the rest " +
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
      .max(RAG_GET_TEXT_MAX_CHAR_LIMIT)
      .optional()
      .describe(
        `Characters to return; 0 = the rest of the document (default ${RAG_GET_TEXT_DEFAULT_CHAR_LIMIT}).`,
      ),
  }),
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
    if ("error" in corpus) {
      return refusal(corpus.error)
    }

    // The defaults are applied HERE and nowhere else: the facade and both
    // runners take explicit values. Left undefined, the upstream MCP would read
    // the limit as 0 and return the rest of the document.
    return ClusterRagClient.getEntryContent({
      projectId: ctx.corpusProjectId,
      entryId: input.entryId,
      charOffset: input.charOffset ?? 0,
      charLimit: input.charLimit ?? RAG_GET_TEXT_DEFAULT_CHAR_LIMIT,
      signal: ctx.signal,
    })
  },
})

// Convenience array for the registry builder.
export const ragTools = [ragQueryTool, ragKeywordSearchTool, ragGetTextTool] as const
