import "server-only"
// lib/cluster/runner.ts
// Facade that routes to the real ClusterClient or the FakeClusterRunner
// based on the CLUSTER_MODE env variable.
//
// CLUSTER_MODE=fake            → FakeClusterRunner (in-process, no real HTTP)
// CLUSTER_MODE=real             → ClusterClient (real cluster API)
// unset or any other value      → throws (lib/cluster/mode.ts)
//
// All app code submits and cancels jobs through this facade; it never imports
// ClusterClient or FakeClusterRunner directly.
import type { ClusterIngestRequest, ClusterQueueProgress } from "./contracts"
import { ClusterClient } from "./client"
import { FakeClusterRunner } from "./fake"
import { CLUSTER_MODE, clusterMode } from "./mode"

export const ClusterRunner = {
  async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    return clusterMode() === CLUSTER_MODE.REAL
      ? ClusterClient.submit(req)
      : FakeClusterRunner.submit(req)
  },

  /**
   * Live queue-status read-model for a run. Fake mode has no real pipeline to
   * report on (the FakeClusterRunner drives terminal progress directly), so it
   * returns null and the UI falls back to the reassurance banner.
   */
  async progress(
    clusterJobId: string,
  ): Promise<ClusterQueueProgress | null> {
    return clusterMode() === CLUSTER_MODE.REAL ? ClusterClient.progress(clusterJobId) : null
  },

  async cancel(clusterJobId: string): Promise<void> {
    return clusterMode() === CLUSTER_MODE.REAL
      ? ClusterClient.cancel(clusterJobId)
      : FakeClusterRunner.cancel(clusterJobId)
  },
}
