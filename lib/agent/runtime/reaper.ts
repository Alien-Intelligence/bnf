// lib/agent/runtime/reaper.ts
// Crash-recovery orphan sweep.
//
// As of the chat-sdk v0.4 migration the live turn lifecycle is owned by the
// SDK TurnRuntime (it aborts stale in-memory turns itself via its reaper). The
// one thing the SDK's storage-agnostic contract does NOT cover is DB orphans:
// Message rows left in status="streaming" with AppSession.activeMessageId set
// after a PROCESS RESTART, where the in-memory turn that was driving them is
// gone. `runReaperCycle` marks those rows as error and clears the pointer so
// the UI doesn't show a forever-spinner.
//
// Without an in-process registry to cross-check (the SDK runtime owns that and
// does not expose a full active-id list), this is intended as a BOOT-TIME or
// manual sweep — run it at startup before serving, when nothing is in flight.
// Do NOT wire it to a periodic interval during normal operation: mid-flight
// turns legitimately sit in status="streaming".

import "server-only"

import { prisma } from "@/lib/db"

export async function runReaperCycle(): Promise<void> {
  const now = new Date()

  const orphaned = await prisma.message.findMany({
    where: { status: "streaming" },
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
    prisma.appSession.updateMany({
      where: {
        id: { in: appSessionIds },
        activeMessageId: { in: orphanedIds },
      },
      data: { activeMessageId: null },
    }),
  ])
}
