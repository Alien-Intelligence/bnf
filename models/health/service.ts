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
import { mcpEnvState, requireClusterEnv } from "@/lib/env"
import { CLUSTER_MODE, clusterMode } from "@/lib/cluster/mode"
import { HEALTH_PROBE_TIMEOUT_MS, HEALTH_PROBE_TTL_MS } from "@/lib/constants"
import { HealthQueries } from "./queries"
import type { HealthSnapshot } from "./schema"

/** Outcome of the connectivity probe. `true` = the server is unreachable. A
 *  server that is simply NOT CONFIGURED (e.g. local dev without any BnF MCP
 *  env) is `false` — we can't probe it, so we don't raise a false alarm. A
 *  MISconfigured one (half the env, a malformed URL) is `true`: that
 *  deployment cannot reach it. */
type Connectivity = { bnfMcpDown: boolean; dataclusterDown: boolean }

// Module-level probe cache: the header polls per tab every HEALTH_POLL_MS, so
// cache the (slow-changing) reachability result for HEALTH_PROBE_TTL_MS to share
// one handshake across concurrent / repeated polls instead of opening a fresh
// MCP session each time. `injectedNow` keeps the TTL check testable.
let probeCache: { at: number; value: Connectivity } | null = null

/**
 * Attempt an MCP `initialize` handshake; true when the server answers. A
 * failed handshake is the answer "unreachable" — the lane goes red — and its
 * cause is logged, so a red lane can be explained from the server logs.
 */
async function reachable(server: string, url: string, token: string): Promise<boolean> {
  try {
    await openMcpSession(url, token, AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS))
    return true
  } catch (err) {
    console.error(`[health] ${server} MCP handshake with ${url} failed:`, err instanceof Error ? err.message : err)
    return false
  }
}

async function probeConnectivity(now: number): Promise<Connectivity> {
  if (probeCache && now - probeCache.at < HEALTH_PROBE_TTL_MS) {
    return probeCache.value
  }

  // BnF MCP — probe only when configured. Unconfigured ≠ down; misconfigured = down.
  const mcp = mcpEnvState()
  let bnfMcpDown: boolean
  switch (mcp.kind) {
    case "unconfigured":
      bnfMcpDown = false
      break
    case "invalid":
      console.error("[health] BnF MCP env is set but invalid:", mcp.reason)
      bnfMcpDown = true
      break
    case "configured":
      bnfMcpDown = !(await reachable("BnF", mcp.env.BNF_MCP_URL, mcp.env.BNF_MCP_TOKEN))
      break
  }

  // Data-cluster MCP — only meaningful under CLUSTER_MODE=real (fake mode has no
  // real cluster, so it is healthy by definition).
  let dataclusterDown = false
  if (clusterMode() === CLUSTER_MODE.REAL) {
    let env: ReturnType<typeof requireClusterEnv> | null = null
    try {
      env = requireClusterEnv()
    } catch (err) {
      // Real mode without the data-cluster env cannot reach the cluster: the
      // lane is down (red), and the reason is logged — never a green lane.
      console.error("[health] data-cluster env missing in real mode:", err instanceof Error ? err.message : err)
    }
    dataclusterDown = env === null || !(await reachable("data-cluster", env.DATACLUSTER_MCP_URL, env.CLUSTER_BEARER_TOKEN))
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
