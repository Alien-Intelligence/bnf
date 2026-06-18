// lib/agent/runtime/reaper.ts
// Server-only background reaper.
//
// Two complementary safety nets:
//
// 1. In-registry reaper: iterates TurnRegistry and aborts any turn whose
//    startedAt age exceeds TURN_REAP_TTL_MS.  Handles the case where the
//    runner never finishes and the entry stays in memory.
//
// 2. DB reaper: queries for Message rows whose status is still "streaming"
//    but whose id is NOT in TurnRegistry.activeMessageIds().  These are
//    "orphaned" rows — the process restarted (hot-reload, crash) while a
//    turn was in flight.  The reaper marks them "error" so the UI doesn't
//    show a spinner forever.
//
// The reaper is started once at module load time via startReaper() — call it
// from the app bootstrap path (e.g. lib/agent/index.ts or the first route
// file that imports the runtime).  Calling it multiple times is safe; the
// flag guard prevents duplicate intervals.

import "server-only"

import { prisma } from "@/lib/db"
import { TURN_REAP_TTL_MS, REAPER_INTERVAL_MS } from "@/lib/constants"
import { TurnRegistry } from "./registry"

let started = false

/**
 * Start the background reaper interval.  Idempotent — safe to call multiple
 * times (only one interval is ever created).
 */
export function startReaper(): void {
  if (started) return
  started = true

  setInterval(() => {
    void runReaperCycle().catch((err) => {
      console.error("[reaper] cycle failed:", err)
    })
  }, REAPER_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function runReaperCycle(): Promise<void> {
  const now = new Date()

  // --- In-registry reaper: abort stale turns ---
  for (const turn of TurnRegistry.all()) {
    const ageMs = now.getTime() - turn.startedAt.getTime()
    if (ageMs > TURN_REAP_TTL_MS) {
      console.warn(
        `[reaper] aborting stale turn ${turn.turnId} ` +
          `(age ${Math.round(ageMs / 1000)}s > TTL ${TURN_REAP_TTL_MS / 1000}s)`,
      )
      turn.controller.abort()
      // The runner's finally block will handle DB cleanup and unregistration.
    }
  }

  // --- DB reaper: mark orphaned streaming rows as error ---
  const activeIds = TurnRegistry.activeMessageIds()

  // Find Message rows that are still "streaming" but not in the registry
  const orphaned = await prisma.message.findMany({
    where: {
      status: "streaming",
      // Exclude rows currently being written by the registry
      ...(activeIds.length > 0 ? { id: { notIn: activeIds } } : {}),
    },
    select: { id: true, appSessionId: true },
  })

  if (orphaned.length === 0) return

  console.warn(
    `[reaper] found ${orphaned.length} orphaned streaming message(s) — marking as error`,
  )

  const orphanedIds = orphaned.map((m) => m.id)
  const appSessionIds = [...new Set(orphaned.map((m) => m.appSessionId))]

  await prisma.$transaction([
    prisma.message.updateMany({
      where: { id: { in: orphanedIds } },
      data: {
        status: "error",
        error: "Turn interrupted — process restarted while streaming.",
        finishedAt: now,
      },
    }),
    // Clear activeMessageId on any session pointing at an orphaned message
    prisma.appSession.updateMany({
      where: {
        id: { in: appSessionIds },
        activeMessageId: { in: orphanedIds },
      },
      data: { activeMessageId: null },
    }),
  ])
}
