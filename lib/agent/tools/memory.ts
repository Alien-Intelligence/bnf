/**
 * Memory tool definitions for the BnF corpus/research agent.
 *
 * Two tools:
 *   - memory_read  — read the project memory for a given scope
 *   - memory_write — upsert a curated fact into project memory
 *
 * Memory is small and durable (not the conversation context). It is
 * re-injected at the start of every session via the system prompt.
 * The `memory_read` tool exists for explicit re-reads during long sessions
 * after a `memory_write` — the agent does NOT need to call it at session
 * start (the system prompt already carries the snapshot).
 *
 * `memory_write` publishes a `memory_event` via `ctx.pubsub` so the memory
 * dialog (if open) re-renders without polling.
 *
 * NOTE: MemoryQueries and MemoryService are stubs in this branch.
 * This module compiles against the Prisma client directly for now and will
 * wire up through the service layer once models/memory is merged.
 *
 * See playbook/memory.md for the full memory model.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import { MEMORY_SCOPE, type MemoryScope } from "@/models/memory/schema"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Resolve both projectId and session scope from the appSession row.
 *
 * A direct Prisma query rather than a service call avoids circular imports.
 * The lookup hits a primary-key index and is effectively free.
 */
async function sessionMeta(
  appSessionId: string,
): Promise<{ projectId: string; scope: string }> {
  const session = await prisma.appSession.findUniqueOrThrow({
    where: { id: appSessionId },
    select: { projectId: true, scope: true },
  })
  return { projectId: session.projectId, scope: session.scope }
}

// Zod enum for memory scopes built from the domain constant.
const memoryScopeEnum = z.enum([
  MEMORY_SCOPE.CORPUS,
  MEMORY_SCOPE.RESEARCH,
] as [MemoryScope, ...MemoryScope[]])

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

export const memoryReadTool = defineTool<
  z.ZodObject<{ scope: z.ZodOptional<typeof memoryScopeEnum> }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.memoryRead,
  description:
    "Read the project memory for the current session scope. " +
    "Call this only when you need a fresh snapshot mid-session — the memory is " +
    "already injected into your system prompt at session start. " +
    "Omit `scope` to use the current session's scope (corpus or research).",
  inputSchema: z.object({
    scope: memoryScopeEnum
      .optional()
      .describe(
        "Memory scope to read. Defaults to the current session scope. " +
          "Allowed: \"corpus\" | \"research\".",
      ),
  }),
  handler: async (input, ctx: TurnScopedCtx) => {
    const { projectId, scope: sessionScope } = await sessionMeta(ctx.appSessionId)
    const resolvedScope = input.scope ?? sessionScope

    const rows = await prisma.memoryItem.findMany({
      where: { projectId, scope: resolvedScope },
      orderBy: [{ section: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    })

    const sections: Record<string, { title: string; items: typeof rows }> = {}
    for (const item of rows) {
      if (!sections[item.section]) {
        sections[item.section] = { title: item.section, items: [] }
      }
      sections[item.section].items.push(item)
    }

    return { sections: Object.values(sections) }
  },
})

// ---------------------------------------------------------------------------
// memory_write
// ---------------------------------------------------------------------------

export const memoryWriteTool = defineTool<
  z.ZodObject<{
    section: z.ZodString
    text: z.ZodString
    origin: z.ZodOptional<z.ZodString>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.memoryWrite,
  description:
    "Write (upsert) a curated fact into the project's persistent memory. " +
    "Near-duplicate facts (same normalised text) are merged rather than duplicated. " +
    "Prefer short, factual sentences. Group related facts under the same section " +
    "(e.g. \"Périmètre temporel\", \"Thèmes\", \"Sources\"). " +
    "After writing, a memory_event is emitted so the memory dialog updates in real time.",
  inputSchema: z.object({
    section: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        "Section heading this fact belongs to (e.g. \"Périmètre temporel\", \"Auteurs clés\").",
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("The fact to remember. One concise sentence."),
    origin: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "How this fact was determined. One of: \"consigne\", \"deduit\", \"action\", \"user\". " +
          "Defaults to \"deduit\".",
      ),
  }),
  handler: async (input, ctx: TurnScopedCtx) => {
    const { projectId, scope } = await sessionMeta(ctx.appSessionId)

    // Inline near-dedup: exact normalised-text match within the same section.
    // MemoryService.write will replace this once models/memory is fully merged.
    const existing = await prisma.memoryItem.findMany({
      where: { projectId, scope, section: input.section },
    })

    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")
    const target = norm(input.text)
    const match = existing.find(
      (e: (typeof existing)[number]) => norm(e.text) === target,
    )

    let item: (typeof existing)[number]
    if (match) {
      item = await prisma.memoryItem.update({
        where: { id: match.id },
        data: {
          text:   input.text,
          origin: input.origin ?? match.origin ?? "deduit",
        },
      })
    } else {
      item = await prisma.memoryItem.create({
        data: {
          projectId,
          scope,
          section:  input.section,
          text:     input.text,
          origin:   input.origin ?? "deduit",
          position: existing.length,
        },
      })
    }

    ctx.pubsub.publish(ctx.turnId, {
      type: "memory_event",
      data: {
        kind:    "write",
        scope,
        section: item.section,
        itemId:  item.id,
      },
    })

    // Prompt-cache invalidation: the cached system prompt now contains stale
    // memory. The prompt-builder caches per (projectId, scope); invalidation
    // is best-effort — if the path doesn't exist yet (parallel commit), we
    // swallow the error and rely on the next session-start rebuild.
    try {
      const builderPath = "@/lib/agent/prompts/builder" as string
      const builderMod: { PromptBuilder?: { invalidate?: (p: string, s: string) => void } } | null =
        await import(/* webpackIgnore: true */ builderPath).catch(() => null)
      if (typeof builderMod?.PromptBuilder?.invalidate === "function") {
        builderMod.PromptBuilder.invalidate(projectId, scope)
      }
    } catch {
      // Non-fatal: the next session start will rebuild the prompt from fresh memory.
    }

    return {
      itemId:  item.id,
      section: item.section,
      text:    item.text,
      origin:  item.origin,
    }
  },
})

// Convenience array for the registry builder.
export const memoryTools = [memoryReadTool, memoryWriteTool] as const
