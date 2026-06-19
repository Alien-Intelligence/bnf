/**
 * Corpus tool definitions for the BnF corpus agent.
 *
 * Five tools covering the full lifecycle of corpus mutations and inspection:
 *   - corpus_get_state  — full snapshot (facets + sample) of the current head
 *   - corpus_add        — add ARKs, advancing the version
 *   - corpus_remove     — remove ARKs, advancing the version
 *   - corpus_stats      — lightweight facet-only view (no sample)
 *   - corpus_diff       — compare two version seqs
 *
 * Every mutating tool publishes a `corpus_event` via `ctx.emit` so connected
 * SSE clients receive real-time feedback without polling.
 *
 * ProjectId resolution: resolved lazily from the session row rather than
 * baked into the closure at registry-construction time. This keeps the lookup
 * parallel-safe (no shared mutable state) and avoids a stale projectId if a
 * session were somehow re-used across projects.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import { kickResolve } from "@/lib/documents/resolver"
import { CorpusQueries } from "@/models/corpus/queries"
import { CorpusService } from "@/models/corpus/service"
import { arkSchema } from "@/models/corpus/types"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Resolve the projectId for a given appSession.
 *
 * Using a direct Prisma query rather than a service method keeps this module
 * free of circular imports. The lookup is a single primary-key read — cheap.
 *
 * Throws if the session does not exist (programming error; sessions are created
 * before the registry is built).
 */
async function projectIdFromSession(appSessionId: string): Promise<string> {
  const session = await prisma.appSession.findUniqueOrThrow({
    where: { id: appSessionId },
    select: { projectId: true },
  })
  return session.projectId
}

// ---------------------------------------------------------------------------
// corpus_get_state
// ---------------------------------------------------------------------------

export const corpusGetStateTool = defineTool<
  z.ZodObject<{
    include_sample: z.ZodOptional<z.ZodBoolean>
    sample_limit: z.ZodOptional<z.ZodNumber>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusGetState,
  description:
    "Retrieve the current corpus state for this project: total document count, " +
    "facets (type, language, source, period), and an optional paginated document sample. " +
    "Call this at the start of each corpus session to orient yourself, and after mutations " +
    "to verify the result. Pass include_sample=false when you only need counts/facets.",
  inputSchema: z.object({
    include_sample: z
      .boolean()
      .optional()
      .describe("Whether to include a document sample. Default true."),
    sample_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of sample documents to return (1–100, default 25)."),
  }),
  handler: async (input, ctx) => {
    const includeSample = input.include_sample ?? true
    const sampleLimit = input.sample_limit
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const snapshot = await CorpusQueries.snapshot(
      projectId,
      "head",
      includeSample ? { limit: sampleLimit } : { limit: 0 },
    )
    if (!includeSample) {
      const { sample: _sample, ...rest } = snapshot
      return rest
    }
    return snapshot
  },
})

// ---------------------------------------------------------------------------
// corpus_add
// ---------------------------------------------------------------------------

export const corpusAddTool = defineTool<
  z.ZodObject<{
    arks: z.ZodArray<typeof arkSchema>
    reason: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusAdd,
  description:
    "Add one or more documents (identified by ARK) to the project's corpus. " +
    "The add is INSTANT — documents join the corpus immediately and a new corpus " +
    "version is created. Their BnF metadata (title, date, type, language) is then " +
    "resolved in the BACKGROUND, so this returns before resolution completes. " +
    "ARKs must be valid BnF ARKs (format: ark:/12148/<name>). The reason is stored " +
    "as a version note describing why these documents are relevant. " +
    "IMPORTANT — do NOT pre-filter, cross-reference, or deduplicate against the " +
    "current corpus yourself: pass EVERY ARK you found in one call. This tool " +
    "deduplicates server-side (against the corpus and within the batch) and tells " +
    "you what actually happened — never reason about uniqueness in your head. " +
    "Result fields: `requested` (ARKs you supplied), `added` (newly added this " +
    "call), `duplicates` (supplied ARKs skipped because already present or " +
    "repeated; requested = added + duplicates), `total` (corpus size), `pending` " +
    "(added docs still resolving in the background — tell the librarian their " +
    "metadata is being fetched and will appear shortly), and, when present, " +
    "`nonIngestable` — added ARKs with no digitized full text (e.g. catalogue " +
    "cb… notices) that cannot be searched once ingested; relay these rather than " +
    "implying every document is full-text.",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe(
        "List of BnF ARK identifiers to add (e.g. [\"ark:/12148/bpt6k2839841\"]).",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe(
        "Human-readable reason for adding these documents (stored as a version note).",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    })

    const result = await CorpusService.addArks(project, ctx.user, {
      arks: input.arks,
      reason: input.reason,
    })

    // Resolve the newly-added stubs' metadata in the background, after this
    // turn's response is flushed. Detached from the request — its MCP calls are
    // individually timeout-bounded.
    if (result.pending > 0) kickResolve(projectId)

    ctx.emit?.({
      type: "corpus_event",
      data: {
        kind: "add",
        count: result.lastDeltaAdded,
        versionSeq: result.versionSeq,
      },
    })

    return {
      requested: result.requested,
      added: result.lastDeltaAdded,
      duplicates: result.duplicates,
      versionSeq: result.versionSeq,
      total: result.total,
      pending: result.pending,
      // Only surface the non-ingestable list when non-empty, so a clean add
      // stays terse. When present, the agent relays it (see description).
      ...(result.nonIngestable.length > 0
        ? { nonIngestable: result.nonIngestable }
        : {}),
    }
  },
})

// ---------------------------------------------------------------------------
// corpus_remove
// ---------------------------------------------------------------------------

export const corpusRemoveTool = defineTool<
  z.ZodObject<{
    arks: z.ZodArray<typeof arkSchema>
    reason: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusRemove,
  description:
    "Remove one or more documents (identified by ARK) from the project's corpus. " +
    "Creates a new immutable corpus version. Documents not currently in the corpus " +
    "are silently ignored. Removing a document does NOT delete it from the database — " +
    "it only removes its membership in the current version.",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe("List of BnF ARK identifiers to remove."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("Human-readable reason for removing these documents."),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    })

    const result = await CorpusService.removeArks(project, ctx.user, {
      arks: input.arks,
      reason: input.reason,
    })

    ctx.emit?.({
      type: "corpus_event",
      data: {
        kind: "remove",
        count: result.lastDeltaRemoved,
        versionSeq: result.versionSeq,
      },
    })

    return {
      removed: result.lastDeltaRemoved,
      versionSeq: result.versionSeq,
      total: result.total,
    }
  },
})

// ---------------------------------------------------------------------------
// corpus_stats
// ---------------------------------------------------------------------------

export const corpusStatsTool = defineTool<z.ZodObject<Record<never, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.corpusStats,
  description:
    "Return facet counts (type, language, source, period) and total document count " +
    "for the current corpus — without a document sample. Faster than corpus_get_state " +
    "when you only need aggregate statistics.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const snapshot = await CorpusQueries.snapshot(projectId, "head", { limit: 0 })
    const { sample: _sample, ...stats } = snapshot
    return stats
  },
})

// ---------------------------------------------------------------------------
// corpus_diff
// ---------------------------------------------------------------------------

export const corpusDiffTool = defineTool<
  z.ZodObject<{
    from_seq: z.ZodNumber
    to_seq: z.ZodNumber
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusDiff,
  description:
    "Compare two corpus versions and return the list of ARKs added and removed " +
    "between them. Useful for explaining to the librarian what changed across sessions.",
  inputSchema: z.object({
    from_seq: z
      .number()
      .int()
      .positive()
      .describe("The earlier version sequence number (from)."),
    to_seq: z
      .number()
      .int()
      .positive()
      .describe("The later version sequence number (to)."),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    return CorpusQueries.diff(projectId, input.from_seq, input.to_seq)
  },
})

// Convenience array for the registry builder.
export const corpusTools = [
  corpusGetStateTool,
  corpusAddTool,
  corpusRemoveTool,
  corpusStatsTool,
  corpusDiffTool,
] as const
