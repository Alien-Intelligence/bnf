import "server-only"
// lib/cluster/mode.ts
// Which cluster this process talks to: the in-process fake or the real data
// cluster. Read from CLUSTER_MODE on every call (tests and the e2e harness
// switch it at runtime). The ONE place that interprets the variable, for both
// facades (lib/cluster/runner.ts for ingestion, lib/cluster/rag.ts for RAG).

export const CLUSTER_MODE = { FAKE: "fake", REAL: "real" } as const
export type ClusterMode = (typeof CLUSTER_MODE)[keyof typeof CLUSTER_MODE]

/**
 * CLUSTER_MODE, validated. It is REQUIRED: `fake` or `real`, nothing else, and
 * unset throws (CLAUDE_ERROR_PATTERNS §9 — no default for environment;
 * playbook/mcp-client.md — required variables throw). `.env.example` sets
 * `fake` explicitly and the Helm chart sets `real`, so no deployment relies on
 * a default; a missing or mistyped value must never quietly serve fixture
 * passages and fake ingests in place of the corpus.
 */
export function clusterMode(): ClusterMode {
  const raw = process.env.CLUSTER_MODE
  if (raw === CLUSTER_MODE.FAKE || raw === CLUSTER_MODE.REAL) return raw
  throw new Error(
    `CLUSTER_MODE must be set to "${CLUSTER_MODE.FAKE}" or "${CLUSTER_MODE.REAL}", got ` +
      (raw === undefined ? "nothing (unset)" : `"${raw}"`),
  )
}
