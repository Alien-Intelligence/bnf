// lib/documents/ocr-sync.ts
// OCR-quality sync drainer — pulls worker-v2's per-ARK `ocr-quality/<slug>.json`
// artifacts into DocumentOcr / DocumentFolio (feedback 2026-09-29 #7, Track B,
// plan D7: the app pulls; the terminal callback is not used).
//
// Three triggers, the lib/documents/resolver.ts pattern:
//   - kickOcrSync(arks)   — after() a terminal ingest commit, FORCED: the
//                           ARKs are re-pulled even when already available,
//                           because a re-ingest may have re-OCR'd them;
//   - startOcrSync()      — boot resume + a periodic sweep every
//                           OCR_SYNC_SWEEP_INTERVAL_MS (instrumentation.ts);
//   - the sweep itself    — every indexed ARK still pending (no row, or a
//                           building / unavailable row past its recheck
//                           window), cited ones first. This is also what drives
//                           the backfill of documents indexed before the
//                           feature: the worker queues a rate-gated build for
//                           each missing artifact and answers `building`.
//
// One drain runs at a time (a process-wide guard); a trigger that arrives
// while one is active is folded into it. Bounded per cycle
// (OCR_SYNC_MAX_BATCHES_PER_CYCLE, CLAUDE_ERROR_PATTERNS §14), and every worker
// call is bounded by WORKER_RUNNER_TIMEOUT_MS. A failed batch is logged with
// its ARKs and re-thrown to the caller: its rows are untouched, so the next
// sweep re-asks them — and a failed forced batch goes back on the forced queue.
//
// A no-op unless CLUSTER_MODE=real: the fake runner prepares no pages, so
// there is nothing to sync.
import "server-only"

import { after } from "next/server"

import {
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_BUILDING_RECHECK_MS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_SWEEP_INTERVAL_MS,
  OCR_SYNC_UNAVAILABLE_RECHECK_MS,
} from "@/lib/constants"
import { DocumentQueries } from "@/models/documents/queries"
import { DocumentService, type OcrSyncWritePlan } from "@/models/documents/service"

/** Structured log line for the sync. Prefix lets ops grep `[ocr-sync]`. */
function log(msg: string): void {
  console.log(`[ocr-sync] ${msg}`)
}

function syncEnabled(): boolean {
  return process.env.CLUSTER_MODE === "real"
}

// ---------------------------------------------------------------------------
// Pure planning (tests/models/documents/ocr-sync.test.ts)
// ---------------------------------------------------------------------------

export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk: size must be a positive integer, got ${size}`)
  }
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Forced ARKs are batched exactly as given (deduped) — the pending filter never applies. */
export function planForcedBatches(arks: string[]): string[][] {
  return chunk([...new Set(arks)], OCR_SYNC_BATCH_SIZE)
}

/**
 * Whether a sweep cycle asks for another pending batch: the last one was full
 * (a partial batch means the pending set is exhausted) and the per-cycle
 * budget is not spent.
 */
export function shouldContinueCycle(p: { batchesDone: number; lastBatchSize: number }): boolean {
  return p.lastBatchSize === OCR_SYNC_BATCH_SIZE && p.batchesDone < OCR_SYNC_MAX_BATCHES_PER_CYCLE
}

/** The checked_at cutoffs before which building / unavailable rows are re-asked. */
export function recheckCutoffs(now: Date): { buildingCutoff: Date; unavailableCutoff: Date } {
  return {
    buildingCutoff: new Date(now.getTime() - OCR_SYNC_BUILDING_RECHECK_MS),
    unavailableCutoff: new Date(now.getTime() - OCR_SYNC_UNAVAILABLE_RECHECK_MS),
  }
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

type Tally = { available: number; building: number; unavailable: number }

function addToTally(tally: Tally, plan: OcrSyncWritePlan): void {
  tally.available += plan.available.length
  tally.building += plan.building.length
  tally.unavailable += plan.unavailable.length
}

/** One batch, logged with its ARKs on failure and re-thrown. */
async function syncBatch(arks: string[], tally: Tally): Promise<void> {
  try {
    addToTally(tally, await DocumentService.syncOcrBatch(arks))
  } catch (err) {
    console.error(`[ocr-sync] batch of ${arks.length} failed (${arks.join(", ")}):`, err)
    throw err
  }
}

/**
 * Sync the given ARKs now, batch by batch, regardless of their stored state.
 * Throws on the first failed batch (already logged); earlier batches stay
 * written.
 */
export async function syncOcrForArks(arks: string[]): Promise<Tally> {
  const tally: Tally = { available: 0, building: 0, unavailable: 0 }
  for (const batch of planForcedBatches(arks)) await syncBatch(batch, tally)
  return tally
}

/** One bounded sweep cycle over the pending ARKs. */
async function sweepCycle(): Promise<void> {
  const tally: Tally = { available: 0, building: 0, unavailable: 0 }
  let batchesDone = 0
  let lastBatchSize: number
  do {
    const pending = await DocumentQueries.pendingOcrArks({
      limit: OCR_SYNC_BATCH_SIZE,
      ...recheckCutoffs(new Date()),
    })
    lastBatchSize = pending.length
    if (pending.length > 0) await syncBatch(pending, tally)
    batchesDone += 1
  } while (shouldContinueCycle({ batchesDone, lastBatchSize }))

  if (tally.available + tally.building + tally.unavailable === 0) return
  const left = await DocumentQueries.countPendingOcrArks(recheckCutoffs(new Date()))
  log(
    `cycle: available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}, pending-left=${left}`,
  )
}

// Process-wide re-entrancy guard: one drain at a time. Triggers that arrive
// while it runs are folded in — forced ARKs through the queue, a sweep through
// the flag — and the active drain loops until both are empty.
const forcedQueue = new Set<string>()
const state = { running: false, sweepRequested: false }

async function drain(): Promise<void> {
  if (state.running) return
  state.running = true
  try {
    while (forcedQueue.size > 0 || state.sweepRequested) {
      if (forcedQueue.size > 0) {
        const arks = [...forcedQueue]
        forcedQueue.clear()
        try {
          const tally = await syncOcrForArks(arks)
          log(
            `kick: ${arks.length} ARK(s) — available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}`,
          )
        } catch (err) {
          // Back on the queue: the next sweep's drain re-pulls them, so a
          // re-OCR'd document is not left with its old folios.
          for (const ark of arks) forcedQueue.add(ark)
          throw err
        }
      }
      if (state.sweepRequested) {
        state.sweepRequested = false
        await sweepCycle()
      }
    }
  } finally {
    state.running = false
  }
}

/**
 * Re-pull `arks` after the current response is flushed — called once a
 * terminal ingest commit lands. Must run inside a request scope (`after`).
 */
export function kickOcrSync(arks: string[]): void {
  if (!syncEnabled() || arks.length === 0) return
  for (const ark of arks) forcedQueue.add(ark)
  after(async () => {
    await drain().catch((err: unknown) => {
      console.error("[ocr-sync] kicked drain failed:", err)
    })
  })
}

/**
 * Sweep the pending ARKs (plus any forced ARKs left by a failed kick). Throws
 * what the drain threw; the caller logs it. Resolves immediately when a drain
 * is already active — the flag makes that drain run the sweep.
 */
export async function resumePendingOcrSync(): Promise<void> {
  if (!syncEnabled()) return
  state.sweepRequested = true
  await drain()
}

/**
 * Boot resume + periodic sweep (instrumentation.ts). One boot log line and no
 * timer outside real mode.
 */
export function startOcrSync(): void {
  if (!syncEnabled()) {
    log("disabled: CLUSTER_MODE is not real (no worker artifacts to sync)")
    return
  }
  void resumePendingOcrSync().catch((err: unknown) => {
    console.error("[ocr-sync] boot sweep failed:", err)
  })
  setInterval(() => {
    void resumePendingOcrSync().catch((err: unknown) => {
      console.error("[ocr-sync] periodic sweep failed:", err)
    })
  }, OCR_SYNC_SWEEP_INTERVAL_MS)
}
