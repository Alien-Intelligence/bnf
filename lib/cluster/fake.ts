import "server-only"
// lib/cluster/fake.ts
// FakeClusterRunner — simulates the four ingestion stages in-process.
// Used when CLUSTER_MODE=fake (the default in dev).
//
// The fake runner fires-and-forgets a setImmediate loop that walks through the
// four stages (extract → chunk → embed → index), posting signed progress events
// to the callback URL after each sub-step, then posts a final "done" event.
//
// FAKE_CLUSTER_STAGE_MS controls total stage duration (env; default 5000ms).
// Exported callCount / resetCallCount helpers are used by smoke tests to assert
// that the no-op short-circuit does NOT call submit.
import crypto from "node:crypto"
import type { ClusterIngestRequest, ClusterProgressEvent } from "./contracts"
import { signCallback } from "./callback-auth"

const STAGE_MS = Number(process.env.FAKE_CLUSTER_STAGE_MS ?? 5000)

const _callCount = { current: 0 }
const _cancelHandles = new Map<string, AbortController>()

export const FakeClusterRunner = {
  callCount(): number {
    return _callCount.current
  },

  resetCallCount(): void {
    _callCount.current = 0
  },

  async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    _callCount.current++
    const clusterJobId = `fake-${crypto.randomUUID()}`
    const controller = new AbortController()
    _cancelHandles.set(clusterJobId, controller)

    // Fire-and-forget — deliberately not awaited.
    // Each stage posts three progress ticks then advances to the next stage.
    setImmediate(async () => {
      try {
        const stages = ["extract", "chunk", "embed", "index"] as const
        for (const stage of stages) {
          for (const frac of [0.2, 0.6, 1.0]) {
            if (controller.signal.aborted) return
            await sleep(STAGE_MS / 3)
            await postProgress(req, {
              stage,
              fraction: frac,
              counters: {
                docs: Math.floor(req.added.length * frac),
              },
            })
          }
        }
        if (controller.signal.aborted) return
        await postProgress(req, {
          stage: "done",
          chunksWritten: req.added.length * 12,
          stats: {
            fakeMode: true,
            addedCount: req.added.length,
            removedCount: req.removed.length,
          },
        })
      } catch (e) {
        if (!controller.signal.aborted) {
          await postProgress(req, {
            stage: "failed",
            error: e instanceof Error ? e.message : String(e),
          })
        }
      } finally {
        _cancelHandles.delete(clusterJobId)
      }
    })

    return { clusterJobId }
  },

  async cancel(clusterJobId: string): Promise<void> {
    _cancelHandles.get(clusterJobId)?.abort()
  },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postProgress(
  req: ClusterIngestRequest,
  event: ClusterProgressEvent,
): Promise<void> {
  const body = JSON.stringify(event)
  const sig = signCallback(body, req.callbackSecret)
  await fetch(req.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-callback-signature": sig,
    },
    body,
  })
}
