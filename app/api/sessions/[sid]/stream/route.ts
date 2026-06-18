// app/api/sessions/[sid]/stream/route.ts
// GET — open an SSE stream for the active agent turn on a session.
//
// Protocol (see playbook/agent-streaming.md for the full event vocabulary):
//   1. The server immediately emits a `snapshot` event with all persisted
//      messages from `fromSeq` onwards (full history if omitted). This gives
//      the client a consistent baseline on first connect or after reattach.
//   2. If a turn is in progress (activeMessageId non-null) the server
//      subscribes to TurnPubSub and forwards every AppEvent as a named SSE
//      event until the turn finishes or the client disconnects.
//   3. If no turn is active the server emits `closed` immediately and closes
//      the stream — the client should render history from the snapshot.
//
// Client side: use fetch + a streaming body reader (NOT EventSource) because
// the request is GET but we still want to be able to detect close/error
// without the EventSource reconnect loop. See playbook/agent-streaming.md.
//
// SSE rules:
//   - Every named event: `event: <name>\ndata: <json>\n\n`
//   - Heartbeat (proxy keepalive): `: heartbeat\n\n`
//   - Content-Type: text/event-stream; no JSON wrapper.

import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { notFound } from "@/lib/api-response"
import { AgentQueries } from "@/models/agents/queries"
import { AgentPolicy } from "@/models/agents/policy"
import { AgentService } from "@/models/agents/service"
import { streamQuerySchema } from "@/models/agents/types"
import { TurnPubSub } from "@/lib/agent/runtime/pubsub"
import type { AppEvent } from "@/lib/agent/runtime/types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type RouteCtx = { params: Promise<{ sid: string }> }

/** Interval between SSE heartbeat comments. Keeps proxy connections alive
 *  during silent periods (no events). */
const HEARTBEAT_MS = 15_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode one named SSE event frame. */
function sseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Encode a heartbeat comment (not an event — invisible to EventSource). */
const SSE_HEARTBEAT = ": heartbeat\n\n"

// ---------------------------------------------------------------------------
// GET — open the SSE stream
// ---------------------------------------------------------------------------

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params

  const parsed = parseQuery(req, streamQuerySchema)
  if (parsed instanceof Response) return parsed

  const session = await AgentQueries.getAppSessionWithProject(sid)
  if (!session) return notFound()

  await bouncer.with(AgentPolicy).authorize("stream", {
    session,
    project: session.project,
  })

  const fromSeq = parsed.fromSeq ?? 0

  // Load snapshot before opening the stream — the client needs a consistent
  // baseline even if no turn is currently active.
  const snapshot = await AgentService.snapshot(session, fromSeq)

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string): boolean => {
        try {
          controller.enqueue(encoder.encode(s))
          return true
        } catch {
          // Controller already closed (client disconnected).
          return false
        }
      }

      // --- 1. Snapshot event -------------------------------------------------
      // Always emitted first, even if empty, so the client knows the server
      // is alive and has processed the request.
      write(sseEvent("snapshot", snapshot))

      // --- 2. Subscribe to in-flight turn (if any) --------------------------
      // Use the activeMessageId from the snapshot — it is consistent with the
      // DB read above and avoids a second round-trip.
      const activeMessageId = snapshot.activeMessageId

      if (!activeMessageId) {
        // No turn in progress — emit closed and shut down immediately.
        write(sseEvent("closed", { reason: "no-active-turn" }))
        try {
          controller.close()
        } catch {
          // Already closed.
        }
        return
      }

      // Mutable cleanup references. Both are set before the subscription
      // callback can fire (setImmediate inside TurnPubSub.publish ensures
      // delivery is deferred past the current call stack).
      let unsubscribe: (() => void) | null = null
      let heartbeat: ReturnType<typeof setInterval> | null = null

      const cleanup = (): void => {
        if (unsubscribe) {
          unsubscribe()
          unsubscribe = null
        }
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
      }

      const close = (): void => {
        cleanup()
        try {
          controller.close()
        } catch {
          // Already closed — ignore.
        }
      }

      unsubscribe = TurnPubSub.subscribe(activeMessageId, (event: AppEvent) => {
        const ok = write(sseEvent(event.type, event))
        if (!ok) {
          // Client disconnected mid-stream — clean up and stop.
          cleanup()
          return
        }
        // Terminal events: close the stream after delivery.
        if (event.type === "message-end" || event.type === "error") {
          write(sseEvent("closed", { reason: event.type }))
          close()
        }
      })

      // --- 3. Heartbeat timer -----------------------------------------------
      heartbeat = setInterval(() => {
        const ok = write(SSE_HEARTBEAT)
        if (!ok) cleanup()
      }, HEARTBEAT_MS)
      // Prevent the timer from keeping the Node.js event loop alive in test
      // environments that don't close the stream explicitly.
      if (typeof heartbeat === "object" && heartbeat !== null && "unref" in heartbeat) {
        (heartbeat as { unref(): void }).unref()
      }

      // --- 4. Abort on client disconnect ------------------------------------
      req.signal.addEventListener("abort", () => {
        close()
      })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Prevent Nginx from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  })
})
