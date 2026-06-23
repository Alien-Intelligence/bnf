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
// per-turn BnF-MCP session (a fresh stateful Mcp-Session-Id each turn) via the
// SDK's `buildTools` seam.
//
// Compliance with agent-streaming.md: the route still parses + authorizes
// before delegating to the SDK handler, which returns the SSE stream.

import { createChatHandler } from "@alien/chat-sdk/next"
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { auth } from "@/lib/auth"
import { env } from "@/lib/env"
import { AGENT_MODEL, AGENT_MAX_ITERATIONS, OPENROUTER_APP_NAME } from "@/lib/constants"
import { AgentQueries } from "@/models/agents/queries"
import { AgentPolicy } from "@/models/agents/policy"
import { AgentService } from "@/models/agents/service"
import { UserQueries } from "@/models/users/queries"
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

/** Re-resolve the authenticated user for the tool context. The route wrapper
 *  has already authorized; this fetches the full Prisma user for handlers. */
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
    model: AGENT_MODEL,
    maxToolTurns: AGENT_MAX_ITERATIONS,
    system: async (req) => {
      const session = await AgentQueries.getAppSessionOrThrow(sidFromUrl(req))
      return AgentService.buildSystemPrompt(session)
    },
    // Per-request registry: opens a fresh BnF-MCP session for this turn.
    buildTools: (_req, signal) => buildTurnScopedRegistry(signal),
    buildToolContext: async (req, signal) => {
      const sid = sidFromUrl(req)
      const [session, user] = await Promise.all([
        AgentQueries.getAppSessionOrThrow(sid),
        resolveUser(req),
      ])
      return buildTurnScopedCtx(
        {
          user,
          appSessionId: sid,
          projectId: session.projectId,
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
})

// ---------------------------------------------------------------------------
// POST — start a turn (parse + authorize, then delegate to the SDK handler)
// ---------------------------------------------------------------------------

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("post", { session, project: session.project })
  return handler.POST(req)
})

// ---------------------------------------------------------------------------
// GET — reattach to the session's active turn (replay snapshot + follow live)
// ---------------------------------------------------------------------------

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("stream", { session, project: session.project })
  return handler.GET(req)
})

// ---------------------------------------------------------------------------
// DELETE — cancel the active turn for this session
// ---------------------------------------------------------------------------

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("cancel", { session, project: session.project })

  const active = await handler.runtime?.getActiveTurn(sid)
  const canceled = active ? ((await handler.runtime?.cancel(active.turnId)) ?? false) : false
  return ok<{ canceled: boolean }>({ canceled })
})
