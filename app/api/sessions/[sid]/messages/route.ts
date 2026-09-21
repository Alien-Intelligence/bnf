// app/api/sessions/[sid]/messages/route.ts
// The agent chat endpoint — durable, reattachable turns powered by
// @alien/chat-sdk v0.4's TurnRuntime + BnF's Prisma persistence adapter.
//
//   POST   — send a user message; starts a DETACHED turn and streams it live
//            (survives tab close). Body: { sessionId, messages }.
//   GET     ?sessionId&cursor — reattach: replay a server snapshot then follow
//            the active turn live.
//   DELETE  — cancel the active turn for this session.
//
// This replaces the bespoke /turn (POST/DELETE) + /stream (GET) routes and the
// hand-rolled runtime in lib/agent/runtime/*. The SDK handler owns the turn
// lifecycle; this file supplies BnF's auth, per-session system prompt, and the
// BnF-MCP attachment (the MCP runs stateless — no Mcp-Session-Id needed) via
// the SDK's `buildTools` seam.
//
// Compliance with agent-streaming.md: the route still parses + authorizes
// before delegating to the SDK handler, which returns the SSE stream.

import { createChatHandler } from "@alien/chat-sdk/next"
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { auth } from "@/lib/auth"
import { env } from "@/lib/env"
import {
  AGENT_MODEL,
  AGENT_DEFAULT_MODEL,
  AGENT_MAX_ITERATIONS,
  OPENROUTER_APP_NAME,
  COMPACTION_ENABLED,
  COMPACTION_TRIGGER_RATIO,
  COMPACTION_KEEP_RECENT_MESSAGES,
  COMPACTION_CONTEXT_WINDOW_TOKENS,
} from "@/lib/constants"
import { summarizeForCompaction } from "@/lib/agent/compaction-summarizer"
import { parseQuery } from "@/app/api/_helpers"
import { streamQuerySchema } from "@/models/agents/types"
import { AgentQueries } from "@/models/agents/queries"
import { AgentPolicy } from "@/models/agents/policy"
import {
  AgentService,
  sessionWithProject,
  sessionWithProjectOrThrow,
} from "@/models/agents/service"
import { UserQueries } from "@/models/users/queries"
import { resolveRequestLocale } from "@/lib/locale"
import { canReachCorpus, corpusProjectId } from "@/lib/authz/corpus-source"
import { createPrismaChatAdapter } from "@/lib/agent/persistence/prisma-adapter"
import {
  buildTurnScopedCtx,
  buildTurnScopedRegistry,
  type TurnScopedCtx,
} from "@/lib/agent/tools"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteCtx = { params: Promise<{ sid: string }> }

/** Extract the [sid] route param from the request URL — `buildTools` /
 *  `buildToolContext` / `system` only receive the Request, not route params. */
function sidFromUrl(req: Request): string {
  const m = /\/sessions\/([^/?]+)\/messages/.exec(new URL(req.url).pathname)
  if (!m?.[1]) throw new Error("Could not resolve session id from request URL")
  return decodeURIComponent(m[1])
}

/**
 * Re-resolve the authenticated user for the tool context.
 *
 * api-layers.md forbids an inline `auth.api.getSession` — `withAuth` is meant
 * to be the only way a route obtains its user, and POST/GET/DELETE below all
 * go through it. This is the documented exemption: the SDK's `buildTools` /
 * `buildToolContext` / `system` callbacks are handed a bare Request, and
 * `handler` is a module-scoped singleton shared across every request, so there
 * is no seam through which the `withAuth` user could reach them. Authorization
 * has already happened by the time these run; this only hydrates the full
 * Prisma row the tool handlers need.
 */
async function resolveUser(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session) throw new Error("No authenticated session on chat request")
  const user = await UserQueries.get(session.user.id)
  if (!user) throw new Error("Authenticated user not found")
  return user
}

// Module-scoped singleton: the runtime must be shared across POST (start) and
// GET (reattach) and DELETE (cancel) — see chat-handler.ts.
const handler = createChatHandler<TurnScopedCtx>({
  persistence: createPrismaChatAdapter(),
  claude: {
    // Provider toggle (@alien/chat-sdk v0.7+): `anthropic` (default) calls
    // Anthropic directly; `openrouter` routes the SAME turns + tools + MCP
    // through the OpenRouter gateway. Fixed per handler (the durable runtime
    // holds one runner), so flipping AGENT_PROVIDER is a boot-time choice, not
    // per-request. The browser still speaks mode "claude" either way.
    provider: env.AGENT_PROVIDER,
    apiKey:
      env.AGENT_PROVIDER === "openrouter"
        ? // Guaranteed present: the env superRefine throws at boot if
          // AGENT_PROVIDER=openrouter without OPENROUTER_API_KEY.
          env.OPENROUTER_API_KEY!
        : env.ANTHROPIC_API_KEY,
    // App attribution on the OpenRouter dashboard (HTTP-Referer / X-Title).
    // Ignored under the anthropic provider.
    siteUrl: env.APP_URL,
    appName: OPENROUTER_APP_NAME,
    // Server-side fallback when a request omits `body.model`. Must be valid for
    // the active gateway: a vendor-namespaced OpenRouter slug (GLM 5.2, the
    // default) under openrouter, the bare Anthropic id under the direct path.
    // The UI always sends `body.model`, so this is the floor, not the norm.
    model: env.AGENT_PROVIDER === "openrouter" ? AGENT_DEFAULT_MODEL : AGENT_MODEL,
    maxToolTurns: AGENT_MAX_ITERATIONS,
    system: async (req) => {
      const session = await AgentQueries.getAppSessionOrThrow(sidFromUrl(req))
      // The UI locale rides the LOCALE_HEADER (the SDK has already consumed
      // the POST body by the time this callback runs) and picks the working
      // language of the prompt — FR and EN turns rebuild the cached prompt
      // when they alternate.
      return AgentService.buildSystemPrompt(session, resolveRequestLocale(req))
    },
    // Per-request registry: opens a fresh BnF-MCP session for this turn and
    // registers only the tools for THIS session's scope (corpus vs research) —
    // the boundary gate (a corpus session carries no note tools, a research
    // session no corpus/buffer tools). See toolsForScope().
    buildTools: async (req, signal) => {
      const session = await AgentQueries.getAppSessionOrThrow(sidFromUrl(req))
      return buildTurnScopedRegistry(session.scope as "corpus" | "research", signal)
    },
    buildToolContext: async (req, signal) => {
      const sid = sidFromUrl(req)
      const [session, user] = await Promise.all([
        sessionWithProjectOrThrow(sid),
        resolveUser(req),
      ])
      return buildTurnScopedCtx(
        {
          user,
          appSessionId: sid,
          projectId: session.projectId,
          // Notes, memory and sessions stay local; the corpus, documents and
          // RAG dataset come from the source when this project is derived.
          // Resolved once, here — no tool re-derives it.
          corpusProjectId: corpusProjectId(session.project),
          corpusReachable: canReachCorpus(session.project),
          scope: session.scope as "corpus" | "research",
        },
        req,
        signal,
      )
    },
    // Langfuse trace identity. The SDK already groups by the durable session id;
    // this supplies the one thing it can't infer — the user — plus scope/project
    // labels. No-op unless LANGFUSE_* env keys are set.
    trace: async (req) => {
      const session = await AgentQueries.getAppSessionOrThrow(sidFromUrl(req))
      const user = await resolveUser(req)
      return {
        name: `agent-${session.scope}`,
        userId: user.id,
        tags: [session.scope],
        metadata: { projectId: session.projectId, appSessionId: session.id },
      }
    },
  },
  // Auto-compaction (agent-context-survival Slice 2): fold the oldest turns of a
  // long session into a Haiku-class synopsis before each dispatch, keeping the
  // conversation under the context window. Checkpoint persists on AppSession via
  // the Prisma adapter (load/saveCheckpoint); the summariser preserves ARKs /
  // folios / note-ids. Degrades to the full history on any failure.
  compaction: {
    enabled: COMPACTION_ENABLED,
    triggerRatio: COMPACTION_TRIGGER_RATIO,
    keepRecentMessages: COMPACTION_KEEP_RECENT_MESSAGES,
    contextWindowTokens: COMPACTION_CONTEXT_WINDOW_TOKENS,
    summarize: summarizeForCompaction,
  },
})

// ---------------------------------------------------------------------------
// POST — start a turn (parse + authorize, then delegate to the SDK handler)
// ---------------------------------------------------------------------------

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await sessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("post", { session, project: session.project })
  return handler.POST(req)
})

// ---------------------------------------------------------------------------
// GET — reattach to the session's active turn (replay snapshot + follow live)
// ---------------------------------------------------------------------------

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params

  // `fromSeq` reaches the SDK handler, not our own code, so a bad value would
  // surface as an opaque failure inside it rather than a 400 here. Validating
  // is cheap and api-routes.md admits no exceptions.
  const query = parseQuery(req, streamQuerySchema)
  if (query instanceof Response) return query

  const session = await sessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("stream", { session, project: session.project })
  return handler.GET(req)
})

// ---------------------------------------------------------------------------
// DELETE — cancel the active turn for this session
// ---------------------------------------------------------------------------

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await sessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("cancel", { session, project: session.project })

  const active = await handler.runtime?.getActiveTurn(sid)
  const canceled = active ? ((await handler.runtime?.cancel(active.turnId)) ?? false) : false
  return ok<{ canceled: boolean }>({ canceled })
})
