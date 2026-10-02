// lib/documents/ocr-sync.ts
// OCR-quality sync drainer — pulls worker-v2's per-ARK `ocr-quality/<slug>.json`
// artifacts into DocumentOcr / DocumentFolio (feedback 2026-09-29 #7, Track B,
// plan D7: the app pulls; the terminal callback is not used).
//
// All the work to do is PERSISTED in the database, never in process memory, so
// a restart or a worker outage loses nothing:
//   - an indexed ARK with no DocumentOcr row is pending;
//   - a row is due again at `next_check_at` (building, unavailable, backing off
//     after a contract failure);
//   - a re-ingest commit marks its ARKs due with a resync request, in the same
//     transaction as the commit (IngestService → DocumentService.ocrResyncOp),
//     then calls triggerOcrSync() so the pull happens within seconds.
// The sweep (boot + every OCR_SYNC_SWEEP_INTERVAL_MS) drains whatever is due,
// cited ARKs first; it is also what drives the backfill of documents indexed
// before the feature (the worker answers `building` and builds them).
//
// Failure handling (CLAUDE_ERROR_PATTERNS §10/§14):
//   - OcrSyncUnavailableError (worker unreachable, 5xx, old worker): the drain
//     stops; nothing is written, nobody is penalised; the next sweep retries.
//   - OcrSyncContractError (a 400, an invalid answer): the batch is split in
//     halves until the ARK at fault is isolated; that ARK backs off
//     exponentially and is quarantined after OCR_SYNC_MAX_ATTEMPTS, so one
//     poison ARK can never starve the sweep. The healthy halves are written.
//   - every database await is bounded by OCR_DB_TIMEOUT_MS and the whole drain
//     by OCR_SYNC_DRAIN_DEADLINE_MS; the running guard is released in `finally`.
//
// Layering: a background drainer is a system entry point, the way a route is a
// user one — it calls DocumentService for every write (the only writer of the
// two tables) and DocumentQueries for its reads, never Prisma itself, exactly
// as lib/ingest/watchdog.ts drives IngestService. A no-op unless
// CLUSTER_MODE=real: the fake runner prepares no pages.
import "server-only"

import { withDeadline } from "@/lib/async/deadline"
import { CLUSTER_MODE, clusterMode } from "@/lib/cluster/mode"
import { OcrSyncContractError } from "@/lib/cluster/ocr-quality"
import {
  OCR_DB_TIMEOUT_MS,
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_DRAIN_DEADLINE_MS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_SWEEP_INTERVAL_MS,
} from "@/lib/constants"
import { DocumentQueries } from "@/models/documents/queries"
import { DocumentService } from "@/models/documents/service"
import type { OcrSyncWritePlan } from "@/models/documents/schema"

/** Structured log line for the sync. Prefix lets ops grep `[ocr-sync]`. */
function log(msg: string): void {
  console.log(`[ocr-sync] ${msg}`)
}

// ---------------------------------------------------------------------------
// Pure planning (tests/models/documents/ocr-sync.test.ts)
// ---------------------------------------------------------------------------

/**
 * Whether a sweep asks for another pending batch: the last one was full (a
 * partial batch means the pending set is exhausted) and the per-cycle budget
 * is not spent.
 */
export function shouldContinueCycle(p: { batchesDone: number; lastBatchSize: number }): boolean {
  return p.lastBatchSize === OCR_SYNC_BATCH_SIZE && p.batchesDone < OCR_SYNC_MAX_BATCHES_PER_CYCLE
}

/** Split a batch that broke the contract in two halves to isolate the ARK at fault. */
export function splitBatch(arks: string[]): [string[], string[]] {
  if (arks.length < 2) throw new Error(`splitBatch: cannot split a batch of ${arks.length}`)
  const mid = Math.ceil(arks.length / 2)
  return [arks.slice(0, mid), arks.slice(mid)]
}

/** Milliseconds left before `deadline`, never negative. */
export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now)
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

export type OcrSyncTally = {
  available: number
  building: number
  unavailable: number
  /** ARKs isolated as breaking the contract this drain (backed off or quarantined). */
  rejected: number
}

function emptyTally(): OcrSyncTally {
  return { available: 0, building: 0, unavailable: 0, rejected: 0 }
}

function addPlan(tally: OcrSyncTally, plan: OcrSyncWritePlan): void {
  tally.available += plan.available.length
  tally.building += plan.building.length
  tally.unavailable += plan.unavailable.length
}

/** A drain stops at its deadline or when its owner aborts it. */
type DrainBudget = { deadline: number; signal: AbortSignal }

function budgetLeft(budget: DrainBudget): boolean {
  return !budget.signal.aborted && remainingMs(budget.deadline, Date.now()) > 0
}

/**
 * Sync one batch; on a contract break, bisect until the ARK at fault is
 * isolated and record its rejection. Anything else (worker unavailable,
 * deadline, database) is logged with the batch's ARKs and re-thrown.
 */
async function syncIsolating(arks: string[], tally: OcrSyncTally, budget: DrainBudget): Promise<void> {
  try {
    const plan = await withDeadline(DocumentService.syncOcrBatch(arks), {
      label: `[ocr-sync] batch of ${arks.length}`,
      ms: remainingMs(budget.deadline, Date.now()),
      signal: budget.signal,
    })
    addPlan(tally, plan)
  } catch (err) {
    if (!(err instanceof OcrSyncContractError)) {
      console.error(`[ocr-sync] batch of ${arks.length} failed (${arks.join(", ")}):`, err)
      throw err
    }
    if (arks.length === 1) {
      const [ark] = arks
      console.error(`[ocr-sync] ${ark} breaks the worker contract:`, err.message)
      await withDeadline(DocumentService.recordOcrRejection(ark, err.message, new Date()), {
        label: `[ocr-sync] record rejection of ${ark}`,
        ms: OCR_DB_TIMEOUT_MS,
        signal: budget.signal,
      })
      tally.rejected += 1
      return
    }
    for (const half of splitBatch(arks)) {
      if (!budgetLeft(budget)) return
      await syncIsolating(half, tally, budget)
    }
  }
}

/** One bounded sweep over the due ARKs. */
async function sweepCycle(budget: DrainBudget): Promise<OcrSyncTally> {
  const tally = emptyTally()
  let batchesDone = 0
  let lastBatchSize = 0
  do {
    if (!budgetLeft(budget)) break
    const pending = await withDeadline(
      DocumentQueries.pendingOcrArks({ limit: OCR_SYNC_BATCH_SIZE, now: new Date() }),
      { label: "[ocr-sync] pending ARKs", ms: OCR_DB_TIMEOUT_MS, signal: budget.signal },
    )
    lastBatchSize = pending.length
    if (pending.length > 0) await syncIsolating(pending, tally, budget)
    batchesDone += 1
  } while (shouldContinueCycle({ batchesDone, lastBatchSize }))
  return tally
}

// Process-wide re-entrancy guard: one drain at a time; a trigger that arrives
// while one runs sets `rerun` so the active drain sweeps again (the due rows
// are in the database, so nothing is lost either way).
const state = { running: false, rerun: false }
const lifecycle: { controller: AbortController; stop: (() => void) | null } = {
  controller: new AbortController(),
  stop: null,
}

async function drain(): Promise<void> {
  if (state.running) {
    state.rerun = true
    return
  }
  state.running = true
  const budget: DrainBudget = {
    deadline: Date.now() + OCR_SYNC_DRAIN_DEADLINE_MS,
    signal: lifecycle.controller.signal,
  }
  try {
    do {
      state.rerun = false
      const tally = await sweepCycle(budget)
      if (tally.available + tally.building + tally.unavailable + tally.rejected === 0) continue
      const left = await withDeadline(DocumentQueries.countPendingOcrArks({ now: new Date() }), {
        label: "[ocr-sync] pending count",
        ms: OCR_DB_TIMEOUT_MS,
        signal: budget.signal,
      })
      log(
        `cycle: available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}, rejected=${tally.rejected}, pending-left=${left}`,
      )
    } while (state.rerun && budgetLeft(budget))
  } finally {
    state.running = false
  }
}

function syncEnabled(): boolean {
  return clusterMode() === CLUSTER_MODE.REAL
}

/**
 * Ask for a drain now — called right after an ingest commit has persisted its
 * resync requests (IngestService). Fire-and-forget by design: the work is in
 * the database, so a lost trigger only delays it to the next sweep. Safe
 * outside a request scope (the watchdog's commits).
 */
export function triggerOcrSync(): void {
  if (!syncEnabled()) return
  void drain().catch((err: unknown) => {
    console.error("[ocr-sync] triggered drain failed:", err)
  })
}

/**
 * Drain whatever is due. Throws what the drain threw; the caller logs it.
 * Resolves at once when a drain is already active (that drain sweeps again).
 */
export async function resumePendingOcrSync(): Promise<void> {
  if (!syncEnabled()) return
  await drain()
}

/**
 * Boot resume + periodic sweep (instrumentation.ts). Returns a stop handle
 * that clears the timer and aborts an in-flight drain at its next await. The
 * timer is unref'd so it never holds the process open on shutdown. No signal
 * handler is installed here: a SIGTERM listener would remove Node's default
 * exit; the platform's shutdown ends the process and the unref'd timer with it.
 * One log line and no timer outside real mode.
 */
export function startOcrSync(): { stop: () => void } {
  if (!syncEnabled()) {
    log("disabled: CLUSTER_MODE is not real (no worker artifacts to sync)")
    return { stop: () => {} }
  }
  // A second start (dev hot-reload re-running register()) replaces the first
  // timer instead of stacking another one.
  lifecycle.stop?.()
  lifecycle.controller = new AbortController()
  void resumePendingOcrSync().catch((err: unknown) => {
    console.error("[ocr-sync] boot sweep failed:", err)
  })
  const timer = setInterval(() => {
    void resumePendingOcrSync().catch((err: unknown) => {
      console.error("[ocr-sync] periodic sweep failed:", err)
    })
  }, OCR_SYNC_SWEEP_INTERVAL_MS)
  timer.unref()
  const controller = lifecycle.controller
  const stop = () => {
    clearInterval(timer)
    controller.abort()
    if (lifecycle.stop === stop) lifecycle.stop = null
  }
  lifecycle.stop = stop
  return { stop }
}
