/**
 * Memory tool definitions for the BnF corpus/research agent.
 *
 * Two tools:
 *   - memory_read  — read the project memory for a given scope
 *   - memory_write — upsert a curated fact into project memory
 *
 * Memory is small and durable (not the conversation context). It is
 * re-injected at the start of every session via the system prompt — the
 * session's own scope, plus the OTHER step's memory as a read-only section.
 * The `memory_read` tool exists for explicit re-reads during long sessions
 * after a `memory_write`, or to read past the other scope's prompt cap.
 *
 * `memory_write` authorises through MemoryPolicy, then writes through
 * MemoryService.write (playbook/memory.md: dedup, near-duplicate merge, and the
 * prompt-cache invalidation of every session of the project, awaited). It
 * always records into the session's OWN scope. It publishes a `memory_event`
 * via `ctx.emit` so the memory dialog (if open) re-renders without polling.
 *
 * See playbook/memory.md for the full memory model.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { MemoryPolicy } from "@/models/memory/policy"
import { MemoryQueries } from "@/models/memory/queries"
import { MEMORY_SCOPE, type MemoryScope } from "@/models/memory/schema"
import { MemoryService } from "@/models/memory/service"
import type { TurnScopedCtx } from "./registry-factory"
import { authorizeProjectTool } from "./authorize"
import { AGENT_TOOLS } from "./constants"

// Zod enum for memory scopes built from the domain constant.
const memoryScopeEnum = z.enum([MEMORY_SCOPE.CORPUS, MEMORY_SCOPE.RESEARCH] as [MemoryScope, ...MemoryScope[]])

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

export const memoryReadTool = defineTool<
  z.ZodObject<{ scope: z.ZodOptional<typeof memoryScopeEnum> }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.memoryRead,
  description:
    "Read the project memory for a scope. " +
    "Call this only when you need a fresh snapshot mid-session — your step's memory is " +
    "already injected into your system prompt at session start, and the other step's " +
    "memory too (read-only, capped). " +
    "Omit `scope` to read the current session's scope (corpus or research).",
  inputSchema: z.object({
    scope: memoryScopeEnum
      .optional()
      .describe(
        "Memory scope to read. Defaults to the current session scope. " +
          "Allowed: \"corpus\" | \"research\".",
      ),
  }),
  handler: async (input, ctx: TurnScopedCtx) => {
    return MemoryQueries.snapshot(ctx.projectId, input.scope ?? ctx.scope)
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
    "Write (upsert) ONE curated, atomic fact into the project's persistent memory. " +
    "`text` is hard-capped at 500 characters — this is a small fact list, NOT a " +
    "session log. Never paste a list of search results, a session recap, or an " +
    "enumeration here: record the takeaway in one sentence (e.g. \"Turing & Shannon " +
    "absents de Gallica — uniquement des notices catalogue\"). If you have several " +
    "distinct facts, make several short memory_write calls — do not concatenate them. " +
    "Near-duplicate facts (same section, nearly the same text) are merged rather than duplicated. " +
    "Group related facts under the same section (e.g. \"Périmètre temporel\", \"Thèmes\", \"Sources\"). " +
    "It always records into YOUR step's memory; the other step's agent sees it, read-only, " +
    "from its next turn on. " +
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
      .describe(
        "The fact to remember — ONE atomic fact, one concise sentence, max 500 " +
          "characters (longer text is rejected). Not a session log or a list of " +
          "results: if you have several facts, call memory_write once per fact.",
      ),
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
    const gate = await authorizeProjectTool(ctx, MemoryPolicy, "write")
    if (!gate.ok) return gate.result

    // MemoryService.write dedups (near-duplicates merge), applies the
    // documented "deduit" origin fallback, and invalidates every cached prompt
    // of the project before it returns.
    const item = await MemoryService.write({
      projectId: ctx.projectId,
      scope: ctx.scope,
      section: input.section,
      text: input.text,
      origin: input.origin ?? null,
    })

    ctx.emit?.({
      type: "memory_event",
      data: { kind: "write", scope: ctx.scope, section: item.section, itemId: item.id },
    })

    return { itemId: item.id, section: item.section, text: item.text, origin: item.origin }
  },
})

// Convenience array for the registry builder.
export const memoryTools = [memoryReadTool, memoryWriteTool] as const
