import "server-only"
// lib/cluster/mode.ts
// Which cluster this process talks to: the in-process fake or the real data
// cluster. Read from CLUSTER_MODE on every call (tests and the e2e harness
// switch it at runtime). The ONE place that interprets the variable, for both
// facades (lib/cluster/runner.ts for ingestion, lib/cluster/rag.ts for RAG).

export const CLUSTER_MODE = { FAKE: "fake", REAL: "real" } as const
export type ClusterMode = (typeof CLUSTER_MODE)[keyof typeof CLUSTER_MODE]

/**
 * CLUSTER_MODE, validated. Unset means `fake`, the documented local-dev
 * default (README, .env.example). Any other value than `fake` / `real` is a
 * misconfiguration and throws: a typo such as `Real` or `prod` must not
 * quietly serve fixture passages and fake ingests in place of the corpus.
 */
export function clusterMode(): ClusterMode {
  const raw = process.env.CLUSTER_MODE
  if (raw === undefined) return CLUSTER_MODE.FAKE
  if (raw === CLUSTER_MODE.FAKE || raw === CLUSTER_MODE.REAL) return raw
  throw new Error(
    `CLUSTER_MODE must be "${CLUSTER_MODE.FAKE}" or "${CLUSTER_MODE.REAL}" (or unset for fake), got "${raw}"`,
  )
}
