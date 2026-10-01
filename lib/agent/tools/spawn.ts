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
import {
  defineTool,
  createToolRegistry,
  runClaudeSdk,
  type DefinedTool,
  type ToolRegistry,
} from "@alien/chat-sdk/claude"
import type { ChatEvent } from "@alien/chat-sdk/events"
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
  SPAWN_MAX_CONCURRENT_PER_TURN,
  SPAWN_MAX_PER_SESSION,
  SPAWN_MAX_TOOL_TURNS,
  SPAWN_TIMEOUT_MS,
  SPAWN_SUMMARY_MAX_CHARS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { resolveRequestLocale } from "@/lib/locale"
import { withBnfRateLimit } from "@/lib/mcp/rate-limited-registry"
import { BUFFER_STATUS } from "@/models/buffer/schema"
import { AgentQueries } from "@/models/agents/queries"
import { AgentService } from "@/models/agents/service"
import { MessageQueries } from "@/models/messages/queries"
import { buildSubagentDirective } from "@/lib/agent/prompts/subagent"
import { corpusTools } from "./corpus"
import { bufferTools } from "./buffer"
import { ragTools } from "./rag"
import { docTools } from "./doc"
import { memoryTools } from "./memory"
import { resolveMcpServers, type McpServerEntry } from "./mcp-servers"
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

// ---------------------------------------------------------------------------
// runSpawn — the handler body, with its heavy dependencies injected so the
// caps and the event contract can be tested without an LLM.
// ---------------------------------------------------------------------------

export type SpawnInput = { task: string; tool_allowlist?: string[] }

/** What the child loop is handed; the real runner adds provider plumbing. */
export type SpawnRunnerArgs = {
  system: string
  task: string
  tools: ToolRegistry<TurnScopedCtx>
  toolContext: TurnScopedCtx
  signal: AbortSignal
}
export type SpawnRunner = (args: SpawnRunnerArgs) => AsyncIterable<ChatEvent>

export interface SpawnDeps {
  runner: SpawnRunner
  /** Wall-clock ceiling for the child. */
  timeoutMs: number
  /** The child's system prompt (the parent's grounded prompt + the directive). */
  buildSystem: (ctx: TurnScopedCtx, task: string) => Promise<string>
  /** The BnF MCP server entry for the child, or [] (research scope / no MCP). */
  resolveMcpServers: (signal: AbortSignal) => Promise<McpServerEntry[]>
}

/** A refusal or failure the parent sees plainly. `success: false` is what makes
 *  the chip red (toolCallErrored keys on it). */
export type SpawnFailure = {
  success: false
  error: string
  refused?: "spawn_limit"
  child_tool_calls?: number
}
export type SpawnSuccess = {
  summary: string
  child_tool_calls: number
  buffered_added?: number
  child_error?: string
}
export type SpawnResult = SpawnSuccess | SpawnFailure

/**
 * Children currently running, per appSessionId (a session runs one turn at a
 * time, so this is the per-turn concurrency). In-process on purpose: the app
 * runs one replica, and a crashed process has no running children to count.
 */
const activeBySession = new Map<string, number>()

function spawnLimitRefusal(error: string): SpawnFailure {
  return { success: false, refused: "spawn_limit", error }
}

export async function runSpawn(
  input: SpawnInput,
  ctx: TurnScopedCtx,
  deps: SpawnDeps,
): Promise<SpawnResult> {
  // Fan-out caps FIRST (incident 2026-09-30) — before any event is emitted, so
  // a refused spawn leaves no dangling "start" row. The in-process slot is
  // taken synchronously, before the first await, so concurrent launches cannot
  // all read the same count and over-admit.
  const active = activeBySession.get(ctx.appSessionId) ?? 0
  if (active >= SPAWN_MAX_CONCURRENT_PER_TURN) {
    return spawnLimitRefusal(
      `Déjà ${active} sous-agents en cours dans ce tour (maximum ${SPAWN_MAX_CONCURRENT_PER_TURN}) : ` +
        "attends leur retour avant d'en lancer d'autres — ils partagent le même quota BnF, en " +
        "lancer plus ne va pas plus vite.",
    )
  }
  activeBySession.set(ctx.appSessionId, active + 1)

  try {
    // Durable per-session count. The runtime persists this call's tool_call
    // row before the handler runs, so the count includes the current call —
    // hence `>` rather than `>=`.
    const total = await MessageQueries.countToolCalls(ctx.appSessionId, AGENT_TOOLS.spawnResearch)
    if (total > SPAWN_MAX_PER_SESSION) {
      return spawnLimitRefusal(
        `Limite de ${SPAWN_MAX_PER_SESSION} sous-agents par session atteinte (${total} lancés) : ` +
          "termine ce travail avec les outils directs, ou ouvre une nouvelle session pour un " +
          "nouveau périmètre.",
      )
    }
    return await runChild(input, ctx, deps)
  } finally {
    const now = activeBySession.get(ctx.appSessionId) ?? 1
    if (now <= 1) activeBySession.delete(ctx.appSessionId)
    else activeBySession.set(ctx.appSessionId, now - 1)
  }
}

async function runChild(
  input: SpawnInput,
  ctx: TurnScopedCtx,
  deps: SpawnDeps,
): Promise<SpawnResult> {
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
  }, deps.timeoutMs)

  ctx.emit?.({ type: "subagent_event", data: { kind: "start", scope } })

  const candidatesBefore = scope === "corpus" ? await candidateCount(ctx.projectId) : 0

  try {
    const system = await deps.buildSystem(ctx, input.task)

    // Child registry: the scoped allow-list + the same BnF MCP the parent has
    // (corpus sweeps need it; research does not, but attaching is harmless).
    // Wrapped with the BnF rate limiter like the parent registry: a child's
    // raw bnf__* calls draw on the SAME process-wide buckets, which is what
    // makes 7 children + a parent share one catalogue quota (incident
    // 2026-09-30). Never build a registry in app code without this wrap.
    const mcpServers = scope === "corpus" ? await deps.resolveMcpServers(childController.signal) : []
    const childRegistry = withBnfRateLimit(
      createToolRegistry<TurnScopedCtx>({ tools: childTools, mcpServers }),
    )

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
      // The child reads whatever corpus the parent reads — inheriting the
      // resolved id, never re-deriving it.
      corpusProjectId: ctx.corpusProjectId,
      corpusReachable: ctx.corpusReachable,
      scope,
    }

    let text = ""
    let toolCalls = 0
    let childError: string | null = null

    for await (const ev of deps.runner({
      system,
      task: input.task,
      tools: childRegistry,
      toolContext: childCtx,
      signal: childController.signal,
    })) {
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
      return { success: false, error: `Le sous-agent a échoué : ${childError}`, child_tool_calls: toolCalls }
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
        success: false,
        error:
          `Le sous-agent a dépassé le délai de ${Math.round(deps.timeoutMs / 1000)}s et a été arrêté. ` +
          "Redécoupe la tâche en un périmètre plus étroit.",
      }
    }
    return {
      success: false,
      error: `Le sous-agent n'a pas pu s'exécuter : ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener("abort", onParentAbort)
  }
}

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

/** Same provider the app runs (route.ts). runOpenRouterSdk defaults its
 *  baseURL to OpenRouter; attribution headers + the gateway model slug ride
 *  along. */
const realRunner: SpawnRunner = (args) => {
  const useOpenRouter = env.AGENT_PROVIDER === "openrouter"
  const runner = useOpenRouter ? runOpenRouterSdk : runClaudeSdk
  // Guaranteed present under openrouter: the env superRefine throws at boot
  // if AGENT_PROVIDER=openrouter without OPENROUTER_API_KEY.
  const apiKey = useOpenRouter ? env.OPENROUTER_API_KEY! : env.ANTHROPIC_API_KEY
  const model = useOpenRouter ? resolveOpenRouterModel(AGENT_DEFAULT_MODEL) : AGENT_MODEL
  return runner<TurnScopedCtx>({
    apiKey,
    messages: [{ role: "user", content: args.task }],
    system: args.system,
    tools: args.tools,
    toolContext: args.toolContext,
    model,
    maxToolTurns: SPAWN_MAX_TOOL_TURNS,
    signal: args.signal,
    ...(useOpenRouter
      ? { headers: openRouterHeaders({ siteUrl: env.APP_URL, appName: OPENROUTER_APP_NAME }) }
      : {}),
  })
}

/** Child system prompt = the parent scope's grounded prompt (memory + corpus)
 *  + the sub-agent directive framing the one task. */
async function realBuildSystem(ctx: TurnScopedCtx, task: string): Promise<string> {
  const session = await AgentQueries.getAppSessionOrThrow(ctx.appSessionId)
  const base = await AgentService.buildSystemPrompt(session, resolveRequestLocale(ctx.request))
  return base + buildSubagentDirective(ctx.scope, task)
}

const realDeps: SpawnDeps = {
  runner: realRunner,
  timeoutMs: SPAWN_TIMEOUT_MS,
  buildSystem: realBuildSystem,
  resolveMcpServers,
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
    "plus counts (candidates staged, tool calls) — NOT the sub-agent's transcript. " +
    `At most ${SPAWN_MAX_CONCURRENT_PER_TURN} sub-agents run at once per turn and ` +
    `${SPAWN_MAX_PER_SESSION} per session; sub-agents share one BnF quota, so more ` +
    "parallelism does not go faster — a launch over the cap is refused " +
    "(`refused: \"spawn_limit\"`), not queued.",
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
  handler: (input, ctx) => runSpawn(input, ctx, realDeps),
})

// Convenience array for the registry builder.
export const spawnTools = [spawnResearchTool] as const
