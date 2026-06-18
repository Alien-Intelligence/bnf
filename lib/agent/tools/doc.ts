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
import { prisma } from "@/lib/db"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

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
    "excerpt) and its IIIF manifest URL by ARK. " +
    "Only documents already in this project's corpus can be retrieved — " +
    "pass an ARK from rag_query results or from the user's own reference. " +
    "Returns an error if the ARK is not in the corpus.",
  inputSchema: z.object({
    ark: z
      .string()
      .describe(
        "The BnF ARK identifier (e.g. \"ark:/12148/bpt6k2839841\"). " +
          "Never fabricate or alter an ARK.",
      ),
  }),
  handler: async (input, ctx) => {
    const doc = await prisma.document.findUnique({
      where: {
        projectId_ark: { projectId: ctx.projectId, ark: input.ark },
      },
    })

    if (!doc) {
      return {
        error: "ark_not_in_corpus",
        ark: input.ark,
        message:
          "Ce document ne fait pas partie du corpus de ce projet. " +
          "Seuls les documents du corpus indexé sont accessibles via doc_get.",
      }
    }

    return { document: doc }
  },
})

// Convenience array for the registry builder.
export const docTools = [docGetTool] as const
