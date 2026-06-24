// models/health/queries.ts
// Pure database access for the workspace health indicator. No business logic
// beyond folding the grouped rows into per-lane tallies.
// Imports only from @/lib/db, @/lib/constants, and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import { HEALTH_WINDOW_MS } from "@/lib/constants"
import {
  classifyHealthLane,
  laneStatus,
  type HealthLane,
  type HealthSnapshot,
  type LaneTally,
} from "./schema"

export class HealthQueries {
  /**
   * Aggregate tool-call outcomes across ALL sessions over the last
   * HEALTH_WINDOW_MS into a per-lane health snapshot.
   *
   * Global (not project-scoped) by design: the indicator reports whether the
   * shared services (this app, the Alien cluster, the BnF MCP) are healthy
   * right now, which a failing service affects platform-wide — so the freshest
   * signal is every recent call, regardless of project.
   *
   * One indexed range scan + groupBy on (tool, source, serverName, status).
   * `running` calls are excluded — an in-flight call is neither a success nor a
   * failure yet. Each (tool, source, server) row is mapped to a lane in JS via
   * classifyHealthLane(), keeping the lane definition in one place (schema.ts)
   * rather than encoded in SQL.
   *
   * `now` is injected (not read from the clock here) so the window edge is
   * deterministic for a given call and testable.
   */
  static async snapshot(now: Date = new Date()): Promise<HealthSnapshot> {
    const since = new Date(now.getTime() - HEALTH_WINDOW_MS)

    const rows = await prisma.toolCall.groupBy({
      by: ["tool", "source", "serverName", "status"],
      where: {
        createdAt: { gte: since },
        status: { in: ["ok", "error"] },
      },
      _count: { _all: true },
    })

    const tallies: Record<HealthLane, LaneTally> = {
      app: { ok: 0, error: 0 },
      alien: { ok: 0, error: 0 },
      bnf: { ok: 0, error: 0 },
    }

    for (const row of rows) {
      const lane = classifyHealthLane({
        tool: row.tool,
        source: row.source,
        serverName: row.serverName,
      })
      if (!lane) continue
      const n = row._count._all
      if (row.status === "error") tallies[lane].error += n
      else tallies[lane].ok += n
    }

    return {
      app: { ...tallies.app, status: laneStatus(tallies.app) },
      alien: { ...tallies.alien, status: laneStatus(tallies.alien) },
      bnf: { ...tallies.bnf, status: laneStatus(tallies.bnf) },
      windowMs: HEALTH_WINDOW_MS,
    }
  }
}
