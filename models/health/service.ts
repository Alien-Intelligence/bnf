// models/health/service.ts
// Orchestrates the workspace health snapshot: it merges the DB-derived tool-call
// tallies (HealthQueries) with a live CONNECTIVITY PROBE of the MCP servers.
//
// Why a probe at all: a BnF MCP / data-cluster MCP that is fully down emits NO
// tool calls (the agent never gets those tools), so the tally-only view can't
// see it — the lane would sit green. The probe closes that gap by attempting an
// MCP `initialize` handshake against each configured server.
//
// Attribution (per product decision):
//   • A hosted MCP server unreachable → the ALIEN lane goes red (Alien hosts the
//     MCP infrastructure, so a connection failure is an Alien-side problem).
//   • The BnF lane is NOT affected by connectivity — a down MCP leaves BnF green;
//     BnF only flares on relayed tool-call errors (429/401/403/500…).
import "server-only"

import { openMcpSession } from "@/lib/mcp/session"
import { requireMcpEnv, requireClusterEnv } from "@/lib/env"
import { HEALTH_PROBE_TIMEOUT_MS, HEALTH_PROBE_TTL_MS } from "@/lib/constants"
import { HealthQueries } from "./queries"
import type { HealthSnapshot } from "./schema"

/** Outcome of the connectivity probe. `true` = the server is unreachable. A
 *  server that is simply NOT CONFIGURED (e.g. local dev without BnF MCP env) is
 *  `false` — we can't probe it, so we don't raise a false alarm. */
type Connectivity = { bnfMcpDown: boolean; dataclusterDown: boolean }

// Module-level probe cache: the header polls per tab every HEALTH_POLL_MS, so
// cache the (slow-changing) reachability result for HEALTH_PROBE_TTL_MS to share
// one handshake across concurrent / repeated polls instead of opening a fresh
// MCP session each time. `injectedNow` keeps the TTL check testable.
let probeCache: { at: number; value: Connectivity } | null = null

/** Attempt an MCP `initialize` handshake; true when the server answers. */
async function reachable(url: string, token: string): Promise<boolean> {
  try {
    await openMcpSession(url, token, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS))
    return true
  } catch {
    return false
  }
}

async function probeConnectivity(now: number): Promise<Connectivity> {
  if (probeCache && now - probeCache.at < HEALTH_PROBE_TTL_MS) {
    return probeCache.value
  }

  // BnF MCP — probe only when configured. Unconfigured ≠ down.
  let bnfMcpDown = false
  try {
    const env = requireMcpEnv()
    bnfMcpDown = !(await reachable(env.BNF_MCP_URL, env.BNF_MCP_TOKEN))
  } catch {
    bnfMcpDown = false
  }

  // Data-cluster MCP — only meaningful under CLUSTER_MODE=real (fake mode has no
  // real cluster, so it is healthy by definition).
  let dataclusterDown = false
  if ((process.env.CLUSTER_MODE ?? "fake") === "real") {
    try {
      const env = requireClusterEnv()
      dataclusterDown = !(await reachable(
        env.DATACLUSTER_MCP_URL,
        env.CLUSTER_BEARER_TOKEN,
      ))
    } catch {
      dataclusterDown = false
    }
  }

  const value: Connectivity = { bnfMcpDown, dataclusterDown }
  probeCache = { at: now, value }
  return value
}

export class HealthService {
  /**
   * The full health snapshot the /api/health endpoint returns: tool-call
   * tallies merged with the connectivity probe. The DB query and the probe run
   * concurrently; a hosted MCP being unreachable forces the Alien lane to red
   * (and flags it `unreachable` so the UI explains it as a server-down rather
   * than tool-call failures).
   */
  static async snapshot(): Promise<HealthSnapshot> {
    const now = Date.now()
    const [base, conn] = await Promise.all([
      HealthQueries.snapshot(new Date(now)),
      probeConnectivity(now),
    ])

    const mcpUnreachable = conn.bnfMcpDown || conn.dataclusterDown
    if (!mcpUnreachable) return base

    return {
      ...base,
      alien: { ...base.alien, status: "red", unreachable: true },
    }
  }
}
