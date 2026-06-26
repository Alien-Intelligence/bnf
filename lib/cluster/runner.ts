import "server-only"
// lib/cluster/runner.ts
// Facade that routes to the real ClusterClient or the FakeClusterRunner
// based on the CLUSTER_MODE env variable.
//
// CLUSTER_MODE=fake  (default) → FakeClusterRunner (in-process, no real HTTP)
// CLUSTER_MODE=real             → ClusterClient (real cluster API)
//
// All app code submits and cancels jobs through this facade; it never imports
// ClusterClient or FakeClusterRunner directly.
import type { ClusterIngestRequest, ClusterQueueProgress } from "./contracts"
import { ClusterClient } from "./client"
import { FakeClusterRunner } from "./fake"

export const ClusterRunner = {
  async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real"
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
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real" ? ClusterClient.progress(clusterJobId) : null
  },

  async cancel(clusterJobId: string): Promise<void> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real"
      ? ClusterClient.cancel(clusterJobId)
      : FakeClusterRunner.cancel(clusterJobId)
  },
}
