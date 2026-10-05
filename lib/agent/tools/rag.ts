/**
 * RAG tool definitions for the BnF research agent — three tools over the
 * ingested corpus, all scoped server-side to the project's cluster dataset:
 *
 *   - rag_query          — semantic (vector) search → ARK + folio + char-range
 *                          passages + entryId, each with its folio's OCR quality.
 *   - rag_keyword_search — typo-tolerant keyword search → entry-level hits with
 *                          facet filters (type / lang / source) and each
 *                          document's OCR summary.
 *   - rag_get_text       — selective full-text retrieval by entryId AND the ARK
 *                          of the same search result, plus the OCR quality of
 *                          every folio heading inside the slice.
 *
 * Each tool checks that the project has a committed ingested version (and,
 * for a derived workspace, a live grant) before delegating to
 * ClusterRagClient. If not, it returns failure.ts's `toolFailure` — the chip
 * shows the call did nothing, and the agent reads `error` to explain the
 * situation rather than crashing.
 *
 * OCR quality (feedback 2026-09-29 #7 — see rag-ocr.ts): `ocrLow` is decided by
 * code, every folio carries an explicit `ocrState` so "not known" never reads
 * as "fine", and an `ocrNotice` rides along when anything is low. The reads are
 * corpus-gated, bounded and tied to the turn's signal; a failure throws and the
 * chat-sdk turns it into an isError tool result, so the model sees the failure
 * instead of a silently unannotated result.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { ClusterRagClient, RAG_LOOKUP_STATUS } from "@/lib/cluster/rag"
import { arkSchema } from "@/models/corpus/types"
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
import { AGENT_TOOLS, DOCUMENT_OCR_STATUS_LEGEND, FOLIO_OCR_STATE_LEGEND } from "./constants"
import { NOT_INGESTED_ERROR, resolveIngestedCorpus } from "./ingestion-guard"
import { toolFailure, toolRefusal } from "./failure"
import { withDeadline } from "@/lib/async/deadline"
import { foliosInSlice } from "@/lib/citations/ocr"
import { OCR_DB_TIMEOUT_MS } from "@/lib/constants"
import { arkSchema } from "@/lib/validation/ark"
import { DocumentQueries } from "@/models/documents/queries"
import { ARK_NOT_IN_CORPUS_ERROR } from "./constants"
import {
  annotateKeywordHits,
  annotatePassages,
  annotateTextSlice,
  loadDocOcrIndex,
  loadOcrIndex,
} from "./rag-ocr"

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
    "Each passage also carries its folio's OCR quality: ocrState " +
    `(${FOLIO_OCR_STATE_LEGEND} — only \`recorded\` means the quality is known; any ` +
    "other state is UNKNOWN, never 'good'), ocrQuality (mean word " +
    "confidence 0–1, null when not measured), ocrSource (alto | mistral | vision) " +
    "and ocrLow (true = the folio's text is poorly recognised — an ocrNotice then " +
    "explains it). " +
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
        type: z.array(z.string()).optional().describe("Not applied (see filters)."),
        lang: z.array(z.string()).optional().describe("Not applied (see filters)."),
        source: z.array(z.string()).optional().describe("Not applied (see filters)."),
        yearFrom: z.number().int().optional().describe("Not applied (see filters)."),
        yearTo: z.number().int().optional().describe("Not applied (see filters)."),
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
      return toolFailure(corpus.error)
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
    // Passages come from this corpus' own dataset; the read is gated on it too.
    const index = await loadOcrIndex(
      ctx,
      result.passages.flatMap((p) => (p.folio === null ? [] : [{ ark: p.ark, folio: p.folio }])),
    )
    return {
      ...result,
      ...annotatePassages(result.passages, index),
      ...(ignoredFilters.length > 0 ? { ignoredFilters } : {}),
    }
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
    "Each hit also carries its document's OCR quality: ocrStatus " +
    `(${DOCUMENT_OCR_STATUS_LEGEND}), ` +
    "ocrRate (the BnF \"Taux OCR\", 0–1) and ocrLowFolios / ocrLowFolioCount (the " +
    "folios whose text is poorly recognised) — both null unless ocrStatus is " +
    "`available`: unknown, never 'none'. " +
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
        type: z.string().min(1).optional().describe("Restrict to this document type (e.g. \"press\", \"book\")."),
        lang: z.string().min(1).optional().describe("Restrict to this language code (e.g. \"fr\")."),
        source: z.string().min(1).optional().describe("Restrict to this source (e.g. \"gallica\")."),
      })
      .optional()
      .describe("Exact-match facet filters applied before ranking."),
  }),
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
    if ("error" in corpus) {
      return toolFailure(corpus.error)
    }

    const result = await ClusterRagClient.keywordSearch({
      projectId: ctx.corpusProjectId,
      query: input.query,
      limit: input.limit ?? RAG_KEYWORD_DEFAULT_LIMIT,
      filters: input.filters,
      signal: ctx.signal,
    })
    // Hits come from this corpus' own dataset; the read is gated on it too.
    const docIndex = await loadDocOcrIndex(
      ctx,
      result.hits.map((h) => h.ark),
    )
    return { ...result, ...annotateKeywordHits(result.hits, docIndex) }
  },
})

// ---------------------------------------------------------------------------
// rag_get_text
// ---------------------------------------------------------------------------

/**
 * Refusal when the entry id is not the stated ARK's live entry in the corpus
 * project's dataset — the agent copied the wrong pair, an outdated id, or
 * invented one. It names the live id so the agent can retry at once.
 */
export function entryNotInCorpusError(ark: string, entryId: number, liveEntryId: number | null): string {
  return liveEntryId === null
    ? `Le document ${ark} n'a aucune entrée dans ce corpus : l'entrée ${entryId} ne peut pas être lue. ` +
        `Reprends un ark et un entryId tels qu'un même résultat de ${AGENT_TOOLS.ragQuery} ou ` +
        `${AGENT_TOOLS.ragKeywordSearch} les a donnés.`
    : `L'entrée ${entryId} n'est pas l'entrée actuelle du document ${ark} dans ce corpus : ` +
        `son entrée actuelle est ${liveEntryId}. Relance ${AGENT_TOOLS.ragGetText} avec entryId ${liveEntryId}.`
}

const ragGetTextInputSchema = z.object({
  ark: arkSchema.describe(
    "The ARK of the SAME search result the entryId comes from, verbatim. The entry is read " +
      "only if it belongs to this ARK in the project's corpus.",
  ),
  entryId: z
    .number()
    .int()
    .positive()
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
})

export const ragGetTextTool = defineTool<typeof ragGetTextInputSchema, TurnScopedCtx>({
  name: AGENT_TOOLS.ragGetText,
  description:
    "Retrieve the processed full text of a corpus entry, selectively, by " +
    "character range. Pass the entryId AND the ark of the same rag_query or " +
    "rag_keyword_search result — an id that is not that document's entry in this " +
    "corpus is refused. When the passage carries one (charRange is null for " +
    "documents indexed before offsets existed), use its char range to pull the " +
    "surrounding context (e.g. charOffset slightly before its start). charLimit 0 " +
    "returns the rest of the document; keep slices to a few thousand characters. " +
    "Returns text, totalLength, hasMore and nextOffset for pagination. " +
    "The result also carries ocr.folios — the OCR quality (ocrState, ocrQuality, " +
    "ocrSource, ocrLow — the same fields as rag_query) of each folio whose " +
    "\"## Folio N\" heading falls inside the slice — and ocr.leadingFolioKnown " +
    "(false when the slice starts mid-folio; that folio's quality is then unknown).",
  inputSchema: ragGetTextInputSchema,
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
    if ("error" in corpus) {
      return toolFailure(corpus.error)
    }

    // D8/D12: the ARK must be an indexed document of THIS corpus before
    // anything is read for it.
    const indexed = await withDeadline(
      DocumentQueries.isIndexedInCorpus(ctx.corpusProjectId, input.ark),
      { label: "rag_get_text corpus check", ms: OCR_DB_TIMEOUT_MS, signal: ctx.signal },
    )
    if (!indexed) {
      return toolRefusal(
        ARK_NOT_IN_CORPUS_ERROR,
        `${input.ark} n'est pas un document indexé de ce corpus : reprends l'ARK d'un résultat de recherche.`,
      )
    }

    // The defaults are applied HERE and nowhere else: the facade and both
    // runners take explicit values. Left undefined, the upstream MCP would read
    // the limit as 0 and return the rest of the document.
    const result = await ClusterRagClient.getEntryContent({
      projectId: ctx.corpusProjectId,
      ark: input.ark,
      entryId: input.entryId,
      charOffset: input.charOffset ?? 0,
      charLimit: input.charLimit ?? RAG_GET_TEXT_DEFAULT_CHAR_LIMIT,
      signal: ctx.signal,
    })
    if (result.status === RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS) {
      return toolFailure(entryNotInCorpusError(input.ark, input.entryId, result.liveEntryId))
    }
    const content = result.content
    const { folios } = foliosInSlice(content.text)
    const index = await loadOcrIndex(
      ctx,
      folios.map((folio) => ({ ark: input.ark, folio })),
    )
    // The entry was verified against the ARK above (RAG_LOOKUP_STATUS), so the
    // OCR quality reported is that entry's own document's.
    return { ...content, ark: input.ark, ...annotateTextSlice(content.text, input.ark, index) }
  },
})

// Convenience array for the registry builder.
export const ragTools = [ragQueryTool, ragKeywordSearchTool, ragGetTextTool] as const
