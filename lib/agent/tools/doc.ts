/**
 * Document tool definitions for the BnF research agent.
 *
 * One tool:
 *   - doc_get — fetch a document's metadata and IIIF manifest URL by ARK.
 *
 * The document must already be in the project's corpus (i.e. a row exists in
 * the Document table for this projectId × ark). Documents outside the corpus
 * return a structured error; the agent must not attempt to infer or construct
 * ARKs for them.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { withDeadline } from "@/lib/async/deadline"
import { OCR_DB_TIMEOUT_MS } from "@/lib/constants"
import { arkSchema } from "@/lib/validation/ark"
import { DocumentQueries } from "@/models/documents/queries"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS, ARK_NOT_IN_CORPUS_ERROR, DOCUMENT_OCR_STATUS_LEGEND } from "./constants"
import { CORPUS_ACCESS_REVOKED_ERROR } from "./ingestion-guard"
import { toolFailure, toolRefusal } from "./failure"
import { loadDocOcrSummary } from "./rag-ocr"

// ---------------------------------------------------------------------------
// doc_get
// ---------------------------------------------------------------------------

export const docGetTool = defineTool<
  z.ZodObject<{ ark: z.ZodString }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.docGet,
  description:
    "Fetch a corpus document's metadata (title, author, year, type, language, source, " +
    "excerpt) and its IIIF manifest URL by ARK, plus its OCR quality summary " +
    `(ocr: status — ${DOCUMENT_OCR_STATUS_LEGEND} —, ocrRate = the BnF ` +
    "\"Taux OCR\" 0–1, scoredFolios, and the lowFolios / lowFolioCount whose text " +
    "is poorly recognised; the three counts are null unless status is `available`: " +
    "unknown, never 'none'). " +
    "Only documents already in this project's corpus can be retrieved — " +
    "pass an ARK from rag_query results or from the user's own reference. " +
    "Returns an error if the ARK is not in the corpus.",
  inputSchema: z.object({
    ark: arkSchema.describe(
      "The BnF ARK identifier (e.g. \"ark:/12148/bpt6k2839841\"). " +
        "Never fabricate or alter an ARK.",
    ),
  }),
  handler: async (input, ctx) => {
    // A derived workspace whose grant was revoked no longer reads the source.
    if (!ctx.corpusReachable) return toolFailure(CORPUS_ACCESS_REVOKED_ERROR)

    const doc = await withDeadline(DocumentQueries.getByArk(ctx.corpusProjectId, input.ark), {
      label: "doc_get document read",
      ms: OCR_DB_TIMEOUT_MS,
      signal: ctx.signal,
    })
    if (!doc) {
      return toolRefusal(
        ARK_NOT_IN_CORPUS_ERROR,
        `${input.ark} ne fait pas partie du corpus de ce projet : seuls les ` +
          `documents du corpus indexé sont accessibles via ${AGENT_TOOLS.docGet}.`,
      )
    }

    // Gated by the corpus Document lookup above and, again, inside the read (D8).
    const ocr = await loadDocOcrSummary(ctx, input.ark)
    return { document: doc, ocr }
  },
})

// Convenience array for the registry builder.
export const docTools = [docGetTool] as const
