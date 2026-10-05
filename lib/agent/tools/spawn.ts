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

import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  defineTool,
  createToolRegistry,
  runClaudeSdk,
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
  SPAWN_LABEL_MAX_CHARS,
  SPAWN_MAX_TOOL_TURNS,
  SPAWN_TIMEOUT_MS,
  SPAWN_SUMMARY_MAX_CHARS,
} from "@/lib/constants"
import { resolveRequestLocale } from "@/lib/locale"
import { withBnfRateLimit } from "@/lib/mcp/rate-limited-registry"
import { SUBAGENT_EVENT_KIND, type SubagentEventData, type SubagentTerminalData } from "@/lib/tools/subagent-runs"
import { AgentQueries } from "@/models/agents/queries"
import { AgentService } from "@/models/agents/service"
import { SESSION_SCOPE, type SessionScope } from "@/models/sessions/schema"
import { SPAWN_CLAIM, SessionQueries, type SpawnClaim } from "@/models/sessions/queries"
import { buildSubagentDirective } from "@/lib/agent/prompts/subagent"
import { corpusTools } from "./corpus"
import { bufferTools } from "./buffer"
import { ragTools } from "./rag"
import { docTools } from "./doc"
import { memoryTools } from "./memory"
import { resolveMcpServers, type McpServerEntry } from "./mcp-servers"
import type { TurnScopedCtx } from "./registry-factory"
import { STREAM_DOMAIN_EVENT, emitDomainEvent } from "@/lib/agent/stream-events"
import { AGENT_TOOLS } from "./constants"

/**
 * The app tools a child MAY be granted, per parent scope: read and gather
 * only. A child stages into the buffer (corpus) or reads the index (research);
 * it never commits or edits the corpus, clears or prunes the buffer, writes
 * memory, submits an ingestion, or delegates further — those stay the
 * parent's call, which is what the spawn_research description promises. The
 * pool bounds what a caller-supplied `tool_allowlist` can select; the DEFAULT
 * allow-list (below) is a subset of it.
 */
const CHILD_POOL_NAMES: Record<SessionScope, ReadonlySet<string>> = {
  [SESSION_SCOPE.CORPUS]: new Set([
    AGENT_TOOLS.corpusSearch,
    AGENT_TOOLS.bufferAdd,
    AGENT_TOOLS.bufferList,
    AGENT_TOOLS.bufferStats,
    AGENT_TOOLS.corpusGetState,
    AGENT_TOOLS.corpusList,
    AGENT_TOOLS.corpusStats,
    AGENT_TOOLS.corpusDiff,
    AGENT_TOOLS.memoryRead,
  ]),
  [SESSION_SCOPE.RESEARCH]: new Set([
    AGENT_TOOLS.ragQuery,
    AGENT_TOOLS.ragKeywordSearch,
    AGENT_TOOLS.ragGetText,
    AGENT_TOOLS.docGet,
    AGENT_TOOLS.memoryRead,
  ]),
}

/** The tools a child of a `scope` session may be granted (spawn_research never). */
export function childPool(scope: SessionScope) {
  const candidates = [...corpusTools, ...bufferTools, ...ragTools, ...docTools, ...memoryTools]
  return candidates.filter((t) => CHILD_POOL_NAMES[scope].has(t.name))
}

/**
 * Safe DEFAULT allow-list when the caller does not pass one: the search and
 * staging tools (corpus), or the index reads (research).
 */
export function defaultAllowlist(scope: SessionScope): string[] {
  return scope === SESSION_SCOPE.CORPUS
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
  /** Wall-clock ceiling for the child, from admission to its last event. */
  timeoutMs: number
  /** The child's system prompt (the parent's grounded prompt + the directive). */
  buildSystem: (ctx: TurnScopedCtx, task: string) => Promise<string>
  /** The BnF MCP server entry for the child, or [] (research scope / no MCP). */
  resolveMcpServers: (signal: AbortSignal) => Promise<McpServerEntry[]>
  /** Claim one of the session's runs (SessionQueries.claimSpawnRun). */
  claimRun: (appSessionId: string) => Promise<SpawnClaim>
  /** Give back a claim the launch abandoned before running. */
  releaseRun: (appSessionId: string) => Promise<void>
}

/** A refusal or failure the parent sees plainly. `success: false` is what makes
 *  the chip red (toolCallErrored keys on it). */
export type SpawnFailure = {
  success: false
  error: string
  refused?: "spawn_limit"
  child_tool_calls?: number
  /** Candidates THIS child staged before it failed — they are in the buffer. */
  buffered_added?: number
}
export type SpawnSuccess = {
  summary: string
  child_tool_calls: number
  buffered_added?: number
  child_error?: string
}
export type SpawnResult = SpawnSuccess | SpawnFailure

/** How a child run ended, as its terminal subagent_event reports it. */
type SubagentTerminal = Omit<SubagentTerminalData, "runId" | "scope">

/** A child run's tool result and its terminal event, always together. */
type ChildOutcome = { result: SpawnResult; terminal: SubagentTerminal }

/** A promise that rejects when `signal` aborts (at once if it already has). */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("sous-agent arrêté"))
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

/**
 * A child's bounds: one signal that aborts on a parent cancel OR the
 * wall-clock ceiling, and `race`, which ends ANY await of the run when that
 * signal fires (CLAUDE_ERROR_PATTERNS §14) — the session cap check, the
 * prompt build, the MCP resolve and the child loop alike. A loser that
 * settles after the run was closed is logged, never left unhandled.
 */
type ChildBounds = {
  signal: AbortSignal
  timedOut: () => boolean
  race: <T>(work: Promise<T>, what: string) => Promise<T>
  dispose: () => void
}

function startChildBounds(parent: AbortSignal, timeoutMs: number): ChildBounds {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  // A parent that aborted before this point would never fire its listener.
  if (parent.aborted) controller.abort()
  else parent.addEventListener("abort", onParentAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const stopped = rejectOnAbort(controller.signal)
  // The sentinel carries no information (why the child stopped is read from
  // `timedOut` / the parent signal); its rejection is only observed.
  stopped.catch(() => undefined)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    race: <T,>(work: Promise<T>, what: string): Promise<T> => {
      work.catch((err: unknown) => {
        if (controller.signal.aborted) console.warn(`[spawn_research] ${what} failed after the run stopped:`, err)
      })
      return Promise.race([work, stopped])
    },
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener("abort", onParentAbort)
    },
  }
}

function emitSubagent(ctx: TurnScopedCtx, data: SubagentEventData): void {
  emitDomainEvent(ctx, { type: STREAM_DOMAIN_EVENT.SUBAGENT, data })
}

/**
 * Children currently running, per appSessionId (a session runs one turn at a
 * time, so this is the per-turn concurrency). In-process on purpose: the app
 * runs one replica, and a crashed process has no running children to count.
 */
const activeBySession = new Map<string, number>()

function spawnLimitRefusal(error: string): SpawnFailure {
  return { success: false, refused: "spawn_limit", error }
}

/** The outcome when the bounds fired: the ceiling, or the parent's cancel. */
function stoppedOutcome(bounds: ChildBounds, timeoutMs: number, toolCalls: number, buffered: number | undefined): ChildOutcome {
  const staged = buffered !== undefined ? { buffered_added: buffered } : {}
  if (bounds.timedOut()) {
    return {
      result: {
        success: false,
        error:
          `Le sous-agent a dépassé le délai de ${Math.round(timeoutMs / 1000)}s et a été arrêté. ` +
          "Redécoupe la tâche en un périmètre plus étroit.",
        child_tool_calls: toolCalls,
        ...staged,
      },
      terminal: { kind: SUBAGENT_EVENT_KIND.TIMEOUT, toolCalls, ...(buffered !== undefined ? { buffered } : {}) },
    }
  }
  return {
    result: { success: false, error: "Le sous-agent a été annulé avec le tour.", child_tool_calls: toolCalls, ...staged },
    terminal: { kind: SUBAGENT_EVENT_KIND.ABORTED, toolCalls, ...(buffered !== undefined ? { buffered } : {}) },
  }
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
  // The bounds start now, so every await below is bounded — including the
  // durable cap check, which a slow database could otherwise hang forever
  // while holding this session's concurrency slot.
  const bounds = startChildBounds(ctx.signal, deps.timeoutMs)

  try {
    // Durable per-session cap: one atomic claim per RUN. A refusal (here or
    // above) never counts, and the count does not depend on the SDK having
    // persisted this call's tool_call row first.
    // A launch whose turn is already gone never claims a run.
    if (bounds.signal.aborted) return stoppedOutcome(bounds, deps.timeoutMs, 0, undefined).result
    const claim = deps.claimRun(ctx.appSessionId)
    let claimed: SpawnClaim
    try {
      claimed = await bounds.race(claim, "the session cap check")
    } catch (err) {
      if (!bounds.signal.aborted) throw err
      // The race gave up; a claim that still commits afterwards is given back,
      // so a cancelled turn never burns the session's run budget.
      claim.then(
        (late) => {
          if (late === SPAWN_CLAIM.CLAIMED) {
            void deps.releaseRun(ctx.appSessionId).catch((releaseErr: unknown) => {
              console.error("[spawn_research] could not release an abandoned run claim:", releaseErr)
            })
          }
        },
        () => undefined, // its failure was already reported by bounds.race
      )
      return stoppedOutcome(bounds, deps.timeoutMs, 0, undefined).result
    }
    if (claimed === SPAWN_CLAIM.NO_SESSION) {
      // A fault, not the quota: the turn's session row is gone.
      console.error(`[spawn_research] session ${ctx.appSessionId} not found when claiming a run`)
      return {
        success: false,
        error: "Le sous-agent n'a pas pu démarrer : la session de cette conversation est introuvable.",
      }
    }
    if (claimed === SPAWN_CLAIM.CAP_REACHED) {
      return spawnLimitRefusal(
        `Limite de ${SPAWN_MAX_PER_SESSION} sous-agents par session atteinte : termine ce travail ` +
          "avec les outils directs, ou ouvre une nouvelle session pour un nouveau périmètre.",
      )
    }

    // One start event and, on EVERY path, exactly one terminal event with the
    // same runId (feedback #10e: an uncorrelated start row spun forever, and a
    // timeout / abort / exception emitted no terminal event at all). runChild
    // coerces every failure into an outcome; the catch is the backstop for a
    // fault outside its try, so the pairing holds even then (§15).
    const runId = randomUUID()
    emitSubagent(ctx, {
      kind: SUBAGENT_EVENT_KIND.START,
      runId,
      scope: ctx.scope,
      label: input.task.slice(0, SPAWN_LABEL_MAX_CHARS),
    })
    const outcome = await runChild(input, ctx, deps, bounds).catch((err: unknown): ChildOutcome => {
      const message = err instanceof Error ? err.message : String(err)
      return {
        result: { success: false, error: `Le sous-agent n'a pas pu s'exécuter : ${message}` },
        terminal: { kind: SUBAGENT_EVENT_KIND.ERROR, toolCalls: 0, error: message },
      }
    })
    emitSubagent(ctx, { ...outcome.terminal, runId, scope: ctx.scope })
    return outcome.result
  } finally {
    bounds.dispose()
    const now = activeBySession.get(ctx.appSessionId) ?? 1
    if (now <= 1) activeBySession.delete(ctx.appSessionId)
    else activeBySession.set(ctx.appSessionId, now - 1)
  }
}

async function runChild(
  input: SpawnInput,
  ctx: TurnScopedCtx,
  deps: SpawnDeps,
  bounds: ChildBounds,
): Promise<ChildOutcome> {
  const scope = ctx.scope
  const pool = childPool(scope)
  const poolNames = new Set(pool.map((t) => t.name))

  // Resolve the child's tool set: requested subset ∩ pool, else the safe
  // default. spawn_research can never appear (it is not in the pool).
  const requested = input.tool_allowlist?.filter((n) => poolNames.has(n))
  const allow = new Set(requested && requested.length > 0 ? requested : defaultAllowlist(scope))
  const childTools = pool.filter((t) => allow.has(t.name))

  // What THIS child staged: the staging tools add their exact `added` here.
  // Replaces a project-wide candidate-count delta, which counted a concurrent
  // sibling's additions and hid any clear in between. Reported on EVERY
  // outcome — a child that timed out after staging hundreds must say so, or
  // the parent sweeps again.
  const stagingTally = { added: 0 }
  const buffered = (): number | undefined => (scope === SESSION_SCOPE.CORPUS ? stagingTally.added : undefined)
  let toolCalls = 0

  try {
    const system = await bounds.race(deps.buildSystem(ctx, input.task), "the prompt build")

    // Child registry: the scoped allow-list + the same BnF MCP the parent has
    // (corpus sweeps need it; research does not). Wrapped with the BnF rate
    // limiter like the parent registry: a child's raw bnf__* calls draw on the
    // SAME process-wide buckets, which is what makes 7 children + a parent
    // share one catalogue quota (incident 2026-09-30). Never build a registry
    // in app code without this wrap.
    const mcpServers =
      scope === SESSION_SCOPE.CORPUS
        ? await bounds.race(deps.resolveMcpServers(bounds.signal), "the MCP resolve")
        : []
    const childRegistry = withBnfRateLimit(createToolRegistry<TurnScopedCtx>({ tools: childTools, mcpServers }))

    // Child context: same project/session (so buffer/RAG writes land in this
    // project), child signal, and the parent emit so the child's buffer_event
    // still refreshes the panel — but the child's CHAT events (text/tool) are
    // drained internally and never forwarded, keeping the parent context flat.
    const childCtx: TurnScopedCtx = {
      signal: bounds.signal,
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
      stagingTally,
    }

    let text = ""
    let childError: string | null = null

    const drain = async (): Promise<void> => {
      for await (const ev of deps.runner({
        system,
        task: input.task,
        tools: childRegistry,
        toolContext: childCtx,
        signal: bounds.signal,
      })) {
        if (ev.type === "text-delta") text += ev.text
        else if (ev.type === "tool-call-end") toolCalls += 1
        else if (ev.type === "error") childError = ev.message
      }
    }
    // The wall clock bounds the child even if a runner ignores its signal.
    await bounds.race(drain(), "the child loop")

    // A runner may end its loop quietly on abort rather than throw: why it
    // stopped decides the outcome, not how.
    if (bounds.signal.aborted) return stoppedOutcome(bounds, deps.timeoutMs, toolCalls, buffered())

    const summary = text.trim().slice(0, SPAWN_SUMMARY_MAX_CHARS)
    const staged = buffered()

    // A child that produced no synthesis AND errored is a failure the parent
    // should see plainly; otherwise return the distilled result.
    if (!summary && childError) {
      return {
        result: {
          success: false,
          error: `Le sous-agent a échoué : ${childError}`,
          child_tool_calls: toolCalls,
          ...(staged !== undefined ? { buffered_added: staged } : {}),
        },
        terminal: { kind: SUBAGENT_EVENT_KIND.ERROR, toolCalls, error: childError, ...(staged !== undefined ? { buffered: staged } : {}) },
      }
    }
    return {
      result: {
        summary: summary || "(le sous-agent n'a pas produit de synthèse)",
        child_tool_calls: toolCalls,
        ...(staged !== undefined ? { buffered_added: staged } : {}),
        ...(childError ? { child_error: childError } : {}),
      },
      terminal: { kind: SUBAGENT_EVENT_KIND.DONE, toolCalls, ...(staged !== undefined ? { buffered: staged } : {}) },
    }
  } catch (err) {
    // Coerce any failure into a tool result (§15) — a timeout or a parent
    // abort surfaces as its own outcome, with a clear, actionable message.
    if (bounds.signal.aborted) return stoppedOutcome(bounds, deps.timeoutMs, toolCalls, buffered())
    const message = err instanceof Error ? err.message : String(err)
    const staged = buffered()
    return {
      result: {
        success: false,
        error: `Le sous-agent n'a pas pu s'exécuter : ${message}`,
        child_tool_calls: toolCalls,
        ...(staged !== undefined ? { buffered_added: staged } : {}),
      },
      terminal: { kind: SUBAGENT_EVENT_KIND.ERROR, toolCalls, error: message, ...(staged !== undefined ? { buffered: staged } : {}) },
    }
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
  // Present under openrouter: the env superRefine refuses to boot without it.
  // Checked here rather than asserted, so the type proves it too.
  const openRouterKey = env.OPENROUTER_API_KEY
  if (useOpenRouter && openRouterKey === undefined) {
    throw new Error("AGENT_PROVIDER=openrouter without OPENROUTER_API_KEY (lib/env.ts should have refused to boot)")
  }
  const apiKey = useOpenRouter && openRouterKey !== undefined ? openRouterKey : env.ANTHROPIC_API_KEY
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
  claimRun: (appSessionId) => SessionQueries.claimSpawnRun(appSessionId, SPAWN_MAX_PER_SESSION),
  releaseRun: (appSessionId) => SessionQueries.releaseSpawnRun(appSessionId),
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
    "scope (what to search, which years/types, when to stop). It only searches, " +
    "stages and reads: it CANNOT commit or edit the corpus, discard or clear buffer " +
    "candidates, write memory, or delegate further. Returns a distilled summary " +
    "plus counts (candidates staged — also when it timed out or failed — and tool " +
    "calls), NOT the sub-agent's transcript. " +
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
          "+ doc_get). Beyond the default a child may get the corpus reads " +
          "(corpus_get_state/list/stats/diff) and memory_read — never a tool that " +
          "commits, removes, clears or writes. spawn_research is never available to the child. Never " +
          "bnf__bnf_search_*: a child sweeps with corpus_search, which stages every hit " +
          "with its metadata.",
      ),
  }),
  handler: (input, ctx) => runSpawn(input, ctx, realDeps),
})

// Convenience array for the registry builder.
export const spawnTools = [spawnResearchTool] as const
