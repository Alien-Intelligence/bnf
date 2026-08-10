/**
 * spawn_research — a bounded, isolated generalist sub-agent (design item 7,
 * agent-context-survival plan Slice 1).
 *
 * « Any big research will explode the 1M context window fast. » A heavy sweep
 * (survey 10 years of a periodical; fan out many RAG queries) is delegated to a
 * CHILD agent loop that runs in its OWN context window and returns only a
 * distilled synthesis to the parent. The child's transcript never enters the
 * parent context — the parent sees one `spawn_research` tool call, not the
 * child's dozens of searches. Durable findings survive because the child writes
 * into the same project's BUFFER (corpus scope) or gathers via RAG (research
 * scope), sharing the parent's project/session context.
 *
 * Implementation note (why this is a pure BnF tool, no chat-sdk change): the
 * published SDK already exports self-contained bounded runner generators
 * (`runClaudeSdk` / `runOpenRouterSdk`, identical options shape) and
 * `createToolRegistry`. The handler instantiates the SAME provider the app runs
 * (env.AGENT_PROVIDER), with a SCOPED child registry (the allow-list), a linked
 * AbortController (timeout) + its own maxToolTurns, drains the child's events to
 * a string, and returns it. The alien runner (platform-dispatched subagents) is
 * NOT involved. See the plan's 2026-08-10 refresh.
 *
 * Bounds (CLAUDE_ERROR_PATTERNS §14/§15): SPAWN_MAX_TOOL_TURNS + SPAWN_TIMEOUT_MS
 * cap the child; any failure/timeout is coerced into a tool result (never throws
 * out of the handler, never hangs the parent turn). The child registry never
 * includes spawn_research itself → no recursion.
 */
import "server-only"

import { z } from "zod"
import { defineTool, createToolRegistry, runClaudeSdk, type DefinedTool } from "@alien/chat-sdk/claude"
import {
  runOpenRouterSdk,
  openRouterHeaders,
  resolveOpenRouterModel,
} from "@alien/chat-sdk/openrouter"
import { env } from "@/lib/env"
import {
  AGENT_MODEL,
  AGENT_DEFAULT_MODEL,
  OPENROUTER_APP_NAME,
  SPAWN_MAX_TOOL_TURNS,
  SPAWN_TIMEOUT_MS,
  SPAWN_SUMMARY_MAX_CHARS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { resolveRequestLocale } from "@/lib/locale"
import { BUFFER_STATUS } from "@/models/buffer/schema"
import { AgentQueries } from "@/models/agents/queries"
import { AgentService } from "@/models/agents/service"
import { buildSubagentDirective } from "@/lib/agent/prompts/subagent"
import { corpusTools } from "./corpus"
import { bufferTools } from "./buffer"
import { ragTools } from "./rag"
import { docTools } from "./doc"
import { memoryTools } from "./memory"
import { resolveMcpServers } from "./mcp-servers"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

/**
 * Every app tool a child MAY be granted, per parent scope. The pool bounds what
 * a caller-supplied `tool_allowlist` can select; the DEFAULT allow-list (below)
 * is a safe read/gather subset of it. spawn_research is deliberately absent from
 * both pools → a child can never recurse.
 */
export function childPool(scope: "corpus" | "research"): readonly DefinedTool<z.ZodTypeAny, TurnScopedCtx>[] {
  const shared = memoryTools as unknown as DefinedTool<z.ZodTypeAny, TurnScopedCtx>[]
  const scoped =
    scope === "corpus"
      ? [...corpusTools, ...bufferTools]
      : [...ragTools, ...docTools]
  return [...(scoped as unknown as DefinedTool<z.ZodTypeAny, TurnScopedCtx>[]), ...shared]
}

/**
 * Safe DEFAULT allow-list when the caller does not pass one. Read/gather tools
 * only — a child stages into the buffer or reads RAG, but never commits the
 * corpus, clears the buffer, or writes memory (those stay the parent's call).
 */
export function defaultAllowlist(scope: "corpus" | "research"): string[] {
  return scope === "corpus"
    ? [
        AGENT_TOOLS.corpusSearch,
        AGENT_TOOLS.bufferAdd,
        AGENT_TOOLS.bufferList,
        AGENT_TOOLS.bufferStats,
      ]
    : [
        AGENT_TOOLS.ragQuery,
        AGENT_TOOLS.ragKeywordSearch,
        AGENT_TOOLS.ragGetText,
        AGENT_TOOLS.docGet,
      ]
}

/** Count active buffer candidates for a project (durable evidence of the child's
 *  work — more trustworthy than parsing the child's prose). */
async function candidateCount(projectId: string): Promise<number> {
  return prisma.bufferItem.count({
    where: { projectId, status: BUFFER_STATUS.CANDIDATE },
  })
}

export const spawnResearchTool = defineTool<
  z.ZodObject<{
    task: z.ZodString
    tool_allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.spawnResearch,
  description:
    "Delegate a HEAVY, well-scoped sub-task to an isolated sub-agent that runs in " +
    "its OWN context window and returns only a short synthesis — use this when a " +
    "sweep would otherwise flood your context (e.g. « survey 10 years of Le Figaro " +
    "summer issues », or fan out many RAG queries). The sub-agent shares this " +
    "project: in the corpus step it stages candidates into the BUFFER (you review " +
    "and commit afterwards); in the research step it gathers passages via RAG and " +
    "reports the key ARK+folios. Give ONE self-contained task with the concrete " +
    "scope (what to search, which years/types, when to stop). It CANNOT commit the " +
    "corpus, clear the buffer, or delegate further. Returns a distilled summary " +
    "plus counts (candidates staged, tool calls) — NOT the sub-agent's transcript.",
  inputSchema: z.object({
    task: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe(
        "The self-contained sub-task, in French, with explicit scope and stop " +
          "condition (e.g. « Balaie Gallica pour Le Figaro, étés 1885–1895, et " +
          "dépose les fascicules dans le tampon »).",
      ),
    tool_allowlist: z
      .array(z.string())
      .optional()
      .describe(
        "Optional subset of tool names the sub-agent may use. Omit for a safe " +
          "default (corpus: corpus_search + buffer_add/list/stats; research: rag_* " +
          "+ doc_get). spawn_research is never available to the child.",
      ),
  }),
  handler: async (input, ctx) => {
    const scope = ctx.scope
    const pool = childPool(scope)
    const poolNames = new Set(pool.map((t) => t.name))

    // Resolve the child's tool set: requested subset ∩ pool, else the safe
    // default. spawn_research can never appear (it is not in the pool).
    const requested = input.tool_allowlist?.filter((n) => poolNames.has(n))
    const allow = new Set(requested && requested.length > 0 ? requested : defaultAllowlist(scope))
    const childTools = pool.filter((t) => allow.has(t.name))

    // Bound the child: linked abort (parent cancel propagates) + a wall-clock
    // ceiling. Cleared in `finally` so a completed child never leaves a timer.
    const childController = new AbortController()
    const onParentAbort = () => childController.abort()
    ctx.signal.addEventListener("abort", onParentAbort)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      childController.abort()
    }, SPAWN_TIMEOUT_MS)

    ctx.emit?.({ type: "subagent_event", data: { kind: "start", scope } })

    const candidatesBefore = scope === "corpus" ? await candidateCount(ctx.projectId) : 0

    try {
      // Child system prompt = the parent scope's grounded prompt (memory +
      // corpus) + the sub-agent directive framing the one task.
      const session = await AgentQueries.getAppSessionOrThrow(ctx.appSessionId)
      const base = await AgentService.buildSystemPrompt(session, resolveRequestLocale(ctx.request))
      const system = base + buildSubagentDirective(scope, input.task)

      // Child registry: the scoped allow-list + the same BnF MCP the parent has
      // (corpus sweeps need it; research does not, but attaching is harmless).
      const mcpServers = scope === "corpus" ? await resolveMcpServers(childController.signal) : []
      const childRegistry = createToolRegistry<TurnScopedCtx>({ tools: childTools, mcpServers })

      // Child context: same project/session (so buffer/RAG writes land in this
      // project), child signal, and the parent emit so the child's buffer_event
      // still refreshes the panel — but the child's CHAT events (text/tool) are
      // drained internally and never forwarded, keeping the parent context flat.
      const childCtx: TurnScopedCtx = {
        signal: childController.signal,
        request: ctx.request,
        emit: ctx.emit,
        db: ctx.db,
        user: ctx.user,
        appSessionId: ctx.appSessionId,
        projectId: ctx.projectId,
        scope,
      }

      // Same provider the app runs (route.ts:76-91). runOpenRouterSdk defaults
      // its baseURL to OpenRouter; we pass attribution headers + resolve the
      // model slug for that gateway.
      const useOpenRouter = env.AGENT_PROVIDER === "openrouter"
      const runner = useOpenRouter ? runOpenRouterSdk : runClaudeSdk
      const apiKey = useOpenRouter ? env.OPENROUTER_API_KEY! : env.ANTHROPIC_API_KEY
      const model = useOpenRouter ? resolveOpenRouterModel(AGENT_DEFAULT_MODEL) : AGENT_MODEL

      let text = ""
      let toolCalls = 0
      let childError: string | null = null

      const generator = runner<TurnScopedCtx>({
        apiKey,
        messages: [{ role: "user", content: input.task }],
        system,
        tools: childRegistry,
        toolContext: childCtx,
        model,
        maxToolTurns: SPAWN_MAX_TOOL_TURNS,
        signal: childController.signal,
        ...(useOpenRouter
          ? { headers: openRouterHeaders({ siteUrl: env.APP_URL, appName: OPENROUTER_APP_NAME }) }
          : {}),
      })

      for await (const ev of generator) {
        if (ev.type === "text-delta") text += ev.text
        else if (ev.type === "tool-call-end") toolCalls += 1
        else if (ev.type === "error") childError = ev.message
      }

      const summary = text.trim().slice(0, SPAWN_SUMMARY_MAX_CHARS)
      const buffered =
        scope === "corpus"
          ? Math.max(0, (await candidateCount(ctx.projectId)) - candidatesBefore)
          : undefined

      ctx.emit?.({
        type: "subagent_event",
        data: { kind: "done", scope, toolCalls, ...(buffered !== undefined ? { buffered } : {}) },
      })

      // A child that produced no synthesis AND errored is a failure the parent
      // should see plainly; otherwise return the distilled result.
      if (!summary && childError) {
        return { error: `Le sous-agent a échoué : ${childError}`, child_tool_calls: toolCalls }
      }
      return {
        summary: summary || "(le sous-agent n'a pas produit de synthèse)",
        child_tool_calls: toolCalls,
        ...(buffered !== undefined ? { buffered_added: buffered } : {}),
        ...(childError ? { child_error: childError } : {}),
      }
    } catch (err) {
      // Coerce any failure into a tool result (§15) — including an abort from the
      // timeout, which surfaces as a clear, actionable message.
      if (timedOut) {
        return {
          error:
            `Le sous-agent a dépassé le délai de ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s et a été arrêté. ` +
            "Redécoupe la tâche en un périmètre plus étroit.",
        }
      }
      return { error: `Le sous-agent n'a pas pu s'exécuter : ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener("abort", onParentAbort)
    }
  },
})

// Convenience array for the registry builder.
export const spawnTools = [spawnResearchTool] as const
