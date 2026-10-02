import "server-only"
// lib/cluster/runner.ts
// Facade that routes to the real ClusterClient or the FakeClusterRunner
// based on CLUSTER_MODE (lib/cluster/mode.ts — unset fails, never defaults):
//
// CLUSTER_MODE=fake → FakeClusterRunner (in-process, no real HTTP)
// CLUSTER_MODE=real → ClusterClient (real cluster API)
//
// All app code submits and cancels jobs through this facade; it never imports
// ClusterClient or FakeClusterRunner directly.
import type { WorkerOcrQualitySyncResponse } from "./ocr-quality"
import { CLUSTER_POLL, type ClusterIngestRequest, type ClusterProgressPoll } from "./contracts"
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
   * Poll the live queue-status read-model for a run. Fake mode has no real
   * pipeline to report on (the FakeClusterRunner drives terminal progress
   * directly): the run is reported unknown and the UI falls back to the
   * reassurance banner.
   */
  async progress(clusterJobId: string): Promise<ClusterProgressPoll> {
    return clusterMode() === CLUSTER_MODE.REAL
      ? ClusterClient.progress(clusterJobId)
      : { kind: CLUSTER_POLL.RUN_UNKNOWN }
  },

  /**
   * Per-ARK OCR-quality artifacts (lib/documents/ocr-sync.ts). Real mode only:
   * the fake runner prepares no pages, so there is no artifact to sync. The
   * sync drainer is a no-op outside real mode; reaching this in fake mode is a
   * wiring bug and throws.
   */
  async ocrQualitySync(
    arks: string[],
    signal: AbortSignal,
  ): Promise<WorkerOcrQualitySyncResponse> {
    const mode = clusterMode()
    if (mode !== CLUSTER_MODE.REAL) {
      throw new Error(
        `ClusterRunner.ocrQualitySync: no worker in CLUSTER_MODE=${mode} — the OCR sync runs in real mode only`,
      )
    }
    return ClusterClient.ocrQualitySync(arks, signal)
  },

  async cancel(clusterJobId: string): Promise<void> {
    return clusterMode() === CLUSTER_MODE.REAL
      ? ClusterClient.cancel(clusterJobId)
      : FakeClusterRunner.cancel(clusterJobId)
  },
}
