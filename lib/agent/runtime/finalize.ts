// lib/agent/runtime/finalize.ts
// Server-only: emit the synthetic terminal event sequence and close the
// pubsub channel for a completed (or canceled) turn.
//
// Called unconditionally from runner.ts's finally block after all DB writes
// are done.  SSE subscribers receive the "closed" domain event and know to
// stop listening.

import "server-only"

import { TurnPubSub } from "./pubsub"
import type { AppEvent } from "./types"

/**
 * Publish a synthetic "closed" event to the turn's pubsub channel.
 *
 * @param turnId        The Message.id (== turnId) that is ending.
 * @param appSessionId  Used for logging context only.
 * @param wasCanceled   True when signal.aborted caused the turn to exit.
 */
export async function finalizeTurn(
  turnId: string,
  appSessionId: string,
  wasCanceled: boolean,
): Promise<void> {
  const reason = wasCanceled ? "canceled" : "done"

  const closedEvent: AppEvent = {
    type: "closed",
    data: { reason },
  }

  TurnPubSub.publish(turnId, closedEvent)

  // Debug-level log — useful during development, silent in production.
  if (process.env.NODE_ENV !== "production") {
    console.debug(
      `[finalize] turn ${turnId} (session ${appSessionId}) finished: ${reason}`,
    )
  }
}
