// lib/agent/runtime/pubsub.ts
// Server-only pub/sub channel for agent turn events.
//
// Each turn gets a channel keyed by turnId.  The TurnRunner publishes
// ChatEvents and DomainEvents; the SSE stream route subscribes and forwards
// them to the client.  setImmediate ensures event listeners registered after
// publish() still receive the event in the same microtask checkpoint.

import "server-only"

import { EventEmitter } from "node:events"
import type { AppEvent } from "./types"

class TurnPubSubImpl {
  private readonly emitter = new EventEmitter()

  constructor() {
    // Each turn channel has at most a few SSE clients subscribed; 64 is
    // generous headroom and prevents the Node.js MaxListenersExceededWarning.
    this.emitter.setMaxListeners(64)
  }

  /** Emit an event to all subscribers of the given turn channel.
   *
   * setImmediate defers delivery past the current synchronous call stack so
   * that a subscriber registered inside a publish() handler still receives
   * the event (avoids missed-wakeup bugs during turn startup). */
  publish(turnId: string, event: AppEvent): void {
    setImmediate(() => {
      this.emitter.emit(turnId, event)
    })
  }

  /** Subscribe to events for a turn.
   *
   * Returns an unsubscribe function — call it when the SSE connection closes
   * to prevent a memory leak on long-lived processes. */
  subscribe(
    turnId: string,
    handler: (event: AppEvent) => void,
  ): () => void {
    this.emitter.on(turnId, handler)
    return () => {
      this.emitter.off(turnId, handler)
    }
  }
}

// Singleton — process-scoped.
export const TurnPubSub = new TurnPubSubImpl()
