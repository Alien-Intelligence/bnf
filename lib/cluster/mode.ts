// lib/cluster/mode.ts
// CLUSTER_MODE — which cluster the app drives: `real` (the worker-v2 HTTP API
// and the data-cluster RAG) or `fake` (in-process fixtures). Read through this
// one function so an unset or misspelt value fails loudly as "not set" instead
// of silently running the fake runner in production (CLAUDE_ERROR_PATTERNS §10:
// no default for environment).

export const CLUSTER_MODE = {
  REAL: "real",
  FAKE: "fake",
} as const
export type ClusterMode = (typeof CLUSTER_MODE)[keyof typeof CLUSTER_MODE]

export function clusterMode(): ClusterMode {
  const raw = process.env.CLUSTER_MODE
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`CLUSTER_MODE is not set (expected "${CLUSTER_MODE.REAL}" or "${CLUSTER_MODE.FAKE}")`)
  }
  if (raw === CLUSTER_MODE.REAL || raw === CLUSTER_MODE.FAKE) return raw
  throw new Error(`CLUSTER_MODE must be "${CLUSTER_MODE.REAL}" or "${CLUSTER_MODE.FAKE}", got "${raw}"`)
}
