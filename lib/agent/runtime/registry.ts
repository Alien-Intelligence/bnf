// lib/agent/runtime/registry.ts
// Server-only in-memory registry of running agent turns.
//
// One entry per turn.  Keyed by turnId (== the assistant Message.id created
// at kick-off).  The reaper and the cancel route both need this mapping.
//
// Process-local: hot-reload in dev creates a new singleton per module
// evaluation, but that's acceptable — any in-flight turn's signal is
// unreachable after reload and will be garbage-collected.

import "server-only"

export interface RunningTurn {
  /** Stable identifier — equals the assistant Message.id created at kick-off. */
  readonly turnId: string
  /** The AppSession this turn belongs to. */
  readonly appSessionId: string
  /** The assistant Message row being built. */
  readonly messageId: string
  /** Project owner — used by the cancel route for authorization. */
  readonly userId: string
  /** Detached controller: abort() cancels the turn without touching HTTP. */
  readonly controller: AbortController
  /** Wall-clock start — used by the reaper to detect stale entries. */
  readonly startedAt: Date
}

class TurnRegistryImpl {
  private readonly map = new Map<string, RunningTurn>()

  register(turn: RunningTurn): void {
    this.map.set(turn.turnId, turn)
  }

  unregister(turnId: string): void {
    this.map.delete(turnId)
  }

  get(turnId: string): RunningTurn | undefined {
    return this.map.get(turnId)
  }

  /** Returns the active turn for a session, or undefined if the session is idle. */
  getBySession(appSessionId: string): RunningTurn | undefined {
    for (const turn of this.map.values()) {
      if (turn.appSessionId === appSessionId) return turn
    }
    return undefined
  }

  /** All message ids that are currently streaming — used by the reaper to
   *  cross-check DB rows whose status is still "streaming". */
  activeMessageIds(): string[] {
    return Array.from(this.map.values(), (t) => t.messageId)
  }

  /** Snapshot of all running turns — used by the reaper. */
  all(): RunningTurn[] {
    return Array.from(this.map.values())
  }
}

// Singleton — process-scoped.
export const TurnRegistry = new TurnRegistryImpl()
