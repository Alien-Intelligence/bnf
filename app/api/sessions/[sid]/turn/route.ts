// app/api/sessions/[sid]/turn/route.ts
// POST  — start a new agent turn for the given session.
// DELETE — cancel the currently running turn for the given session.
//
// These two verbs share the route file because they operate on the same
// resource: the active turn of an AppSession. Splitting them into separate
// files would obscure that coupling without adding clarity.
//
// The SSE stream lives at /api/sessions/[sid]/stream/route.ts — a GET that
// the client opens after POST succeeds and keeps open while the turn runs.
//
// Compliance with api-layers.md:
//   withAuth → parseBody/parseQuery → Queries (load) → Policy (authorize)
//   → Service (write) → kick off executeTurn detached → ok<T>()
//
// The `executeTurn` call is intentionally detached (queueMicrotask) so the
// HTTP response returns before the runner starts consuming tokens. The client
// opens the SSE stream immediately after and receives events via TurnPubSub.

import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound, conflict } from "@/lib/api-response"
import { AgentQueries } from "@/models/agents/queries"
import { AgentPolicy } from "@/models/agents/policy"
import { AgentService } from "@/models/agents/service"
import { postTurnSchema } from "@/models/agents/types"
import { TurnRegistry } from "@/lib/agent/runtime/registry"
import { TurnPubSub } from "@/lib/agent/runtime/pubsub"
import { createDetachedController } from "@/lib/agent/runtime/detached-signal"
import { executeTurn } from "@/lib/agent/runtime/runner"
import { buildTurnHistory } from "@/lib/agent/runtime/history"
import {
  buildTurnScopedRegistry,
  buildTurnScopedCtx,
} from "@/lib/agent/tools"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteCtx = { params: Promise<{ sid: string }> }

/** Response shape for a successfully started turn. */
type StartTurnResponse = {
  /** The assistant Message.id — also used as the turn's key in TurnRegistry. */
  turnId: string
  /** Same as turnId. Kept explicit so clients can use either name. */
  messageId: string
  /** The user Message.id created for the submitted text. */
  userMessageId: string
}

/** Response shape for a cancel request. */
type CancelTurnResponse = { canceled: boolean }

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

// TODO(slice-3): replace with the full composed corpus/research system prompt
// built by lib/agent/prompts/ once that module lands. For now, a minimal
// French-language orientation prompt keeps the agent functional and on-brand.
const CORPUS_SYSTEM_PROMPT =
  "Vous êtes un assistant de constitution de corpus pour la Bibliothèque " +
  "nationale de France. Répondez toujours en français. Votre rôle est " +
  "d'aider les bibliothécaires et chercheurs à construire des corpus de " +
  "documents identifiés par leurs ARK Gallica."

// ---------------------------------------------------------------------------
// POST — start a new turn
// ---------------------------------------------------------------------------

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const parsed = await parseBody(req, postTurnSchema)
  if (parsed instanceof Response) return parsed

  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()

  await bouncer.with(AgentPolicy).authorize("post", {
    session,
    project: session.project,
  })

  // Guard: reject if another turn is already streaming.
  // AgentService.startTurn performs the definitive check inside a transaction;
  // this early check gives a cleaner error message.
  if (session.activeMessageId !== null) {
    return conflict("Une réponse est déjà en cours pour cette session.")
  }

  // Establish DB rows (user message + assistant message) and set
  // AppSession.activeMessageId.  The returned assistantMessageId is used as
  // the turnId throughout the runtime — TurnRegistry, TurnPubSub, and
  // executeTurn all key on it.
  const { userMessageId, assistantMessageId } = await AgentService.startTurn(
    session,
    user,
    parsed,
  )

  // turnId == assistantMessageId by convention (see lib/agent/runtime/registry.ts).
  const turnId = assistantMessageId

  // Register the detached AbortController before firing executeTurn — the
  // runner reads it from the registry synchronously at startup.
  const controller = createDetachedController()
  TurnRegistry.register({
    turnId,
    appSessionId: session.id,
    messageId: assistantMessageId,
    userId: user.id,
    controller,
    startedAt: new Date(),
  })

  // Build the tool registry and context for this turn.
  // The registry is intentionally empty until slice-3 wires in BnF tools.
  const registryOpts = {
    user,
    appSessionId: session.id,
    turnId,
    turnMessageId: assistantMessageId,
    pubsub: TurnPubSub,
  }
  const tools = buildTurnScopedRegistry(registryOpts)
  // The detached signal (not request.signal) keeps the turn alive after the
  // HTTP connection closes.
  const toolContext = buildTurnScopedCtx(
    registryOpts,
    req,
    controller.signal,
  )

  // Load message history asynchronously — we need it before executeTurn.
  // Built here so the route has all data assembled before firing the runner.
  const messages = await buildTurnHistory(session.id, assistantMessageId)

  // Fire the runner detached so the HTTP response returns immediately.
  // The client opens the SSE stream and receives events via TurnPubSub.
  queueMicrotask(() => {
    executeTurn({
      messageId: assistantMessageId,
      appSessionId: session.id,
      messages,
      system: CORPUS_SYSTEM_PROMPT,
      tools,
      toolContext,
    }).catch(() => {
      // executeTurn writes its own error events and finalizes the turn.
      // The catch here is a safety net to prevent unhandled promise rejections
      // from crashing the process — executeTurn should never throw out.
    })
  })

  return ok<StartTurnResponse>({ turnId, messageId: assistantMessageId, userMessageId })
})

// ---------------------------------------------------------------------------
// DELETE — cancel the running turn
// ---------------------------------------------------------------------------

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params

  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()

  await bouncer.with(AgentPolicy).authorize("cancel", {
    session,
    project: session.project,
  })

  // Look up the running turn by session — the client does not need to send a
  // turnId because at most one turn can be active per session (enforced by
  // AppSession.activeMessageId @unique constraint and TurnAlreadyActiveError).
  const running = TurnRegistry.getBySession(session.id)
  const canceled = await AgentService.cancelTurn(
    session,
    running?.turnId ?? "",
  )

  return ok<CancelTurnResponse>({ canceled })
})
