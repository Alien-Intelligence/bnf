// lib/documents/ocr-sync.ts
// OCR-quality sync drainer — pulls worker-v2's per-ARK `ocr-quality/<slug>.json`
// artifacts into DocumentOcr / DocumentFolio (feedback 2026-09-29 #7, Track B,
// plan D7: the app pulls; the terminal callback is not used).
//
// All the work to do is PERSISTED in the database, never in process memory, so
// a restart or a worker outage loses nothing:
//   - an indexed ARK with no DocumentOcr row is pending;
//   - a row is due again at `next_check_at` (building, unavailable, backing off,
//     or a re-ingest's resync request written in the commit's own transaction).
// The sweep (boot + every OCR_SYNC_SWEEP_INTERVAL_MS) drains whatever is due,
// corpus by corpus, cited ARKs first; it is also what drives the backfill of
// documents indexed before the feature. A commit nudges it through
// lib/documents/ocr-sync-signal.ts (IngestService never imports this module).
//
// Failure handling (CLAUDE_ERROR_PATTERNS §10/§14):
//   - OcrSyncUnavailableError (worker unreachable, timeout, 5xx, old worker):
//     the batch's ARKs back off (OCR_SYNC_OUTAGE_BACKOFF_MS) so the next sweep
//     asks other ARKs first, without touching their contract budget; the drain
//     stops.
//   - OcrSyncContractError on the EXCHANGE (version skew, 401/403/413, a body
//     that is not a sync answer): the SYNC pauses with an exponential backoff,
//     no ARK is penalised, and the first valid answer resumes it.
//   - OcrSyncContractError on ARKS: named culprits are rejected (backoff, then
//     quarantine after OCR_SYNC_MAX_ATTEMPTS) and the rest of the batch is asked
//     again; unnamed ones are found by bisecting the batch.
//   - one AbortController per drain, fired at OCR_SYNC_DRAIN_DEADLINE_MS,
//     cancels the in-flight request and stops the writes between ARKs; no batch
//     starts unless its worst-case cost still fits; every read is bounded by
//     OCR_DB_TIMEOUT_MS. The running guard is released only once the work has
//     actually stopped.
//
// Layering: a background drainer is the second kind of entry point the
// playbook allows to call services (playbook/api-layers.md, "Background
// drainers"): writes through DocumentService, reads through DocumentQueries,
// never Prisma itself. A no-op unless CLUSTER_MODE=real.
import "server-only"

import { DeadlineExceededError, withDeadline } from "@/lib/async/deadline"
import { workerRequestTimeoutMs } from "@/lib/cluster/client"
import { CLUSTER_MODE, clusterMode } from "@/lib/cluster/mode"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
} from "@/lib/cluster/ocr-quality"
import {
  OCR_DB_TIMEOUT_MS,
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_BATCH_WRITE_MARGIN_MS,
  OCR_SYNC_DRAIN_DEADLINE_MS,
  OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS,
  OCR_SYNC_EXCHANGE_BACKOFF_MAX_MS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_SWEEP_INTERVAL_MS,
} from "@/lib/constants"
import { DocumentQueries } from "@/models/documents/queries"
import type { OcrSyncWritePlan } from "@/models/documents/schema"
import { DocumentService } from "@/models/documents/service"

import { onOcrSyncRequested } from "./ocr-sync-signal"

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/** Split a batch in two halves to isolate an ARK the worker refuses. */
export function splitBatch(arks: string[]): [string[], string[]] {
  if (arks.length < 2) throw new Error(`splitBatch: cannot split a batch of ${arks.length}`)
  const mid = Math.ceil(arks.length / 2)
  return [arks.slice(0, mid), arks.slice(mid)]
}

/** Milliseconds left before `deadline`, never negative. */
export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now)
}

/** Exponential backoff after `failures` consecutive exchange-level breaks. */
export function exchangeBackoffMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error(`exchangeBackoffMs: failures must be a positive integer, got ${failures}`)
  }
  return Math.min(
    OCR_SYNC_EXCHANGE_BACKOFF_BASE_MS * 2 ** (failures - 1),
    OCR_SYNC_EXCHANGE_BACKOFF_MAX_MS,
  )
}

// ---------------------------------------------------------------------------
// The drainer core — I/O through ports, so its behaviour is tested
// (tests/models/documents/ocr-sync.test.ts).
// ---------------------------------------------------------------------------

export type OcrSyncPorts = {
  pendingByCorpus(
    now: Date,
    signal: AbortSignal,
  ): Promise<Array<{ corpusProjectId: string; pending: number }>>
  pendingArks(corpusProjectId: string, limit: number, now: Date, signal: AbortSignal): Promise<string[]>
  syncBatch(arks: string[], signal: AbortSignal): Promise<OcrSyncWritePlan>
  recordRejection(ark: string, message: string, now: Date, signal: AbortSignal): Promise<void>
  recordUnavailable(arks: string[], message: string, now: Date, signal: AbortSignal): Promise<void>
  /** Worst-case cost of one batch (request timeout + write margin). */
  batchCostMs(): number
  now(): number
  log(message: string): void
  error(message: string, err: unknown): void
}

export type OcrSyncLimits = {
  drainDeadlineMs: number
  batchSize: number
  maxBatches: number
}

export type OcrSyncTally = {
  available: number
  building: number
  unavailable: number
  /** ARKs pinned as breaking the contract this drain (backed off or quarantined). */
  rejected: number
  /** ARKs backed off because the worker could not be asked. */
  outage: number
}

/** Why a drain stopped. */
export const OCR_SYNC_STOP = {
  DONE: "done",
  BUDGET: "budget",
  DEADLINE: "deadline",
  WORKER_UNAVAILABLE: "worker_unavailable",
  EXCHANGE_PAUSED: "exchange_paused",
  COALESCED: "coalesced",
} as const
export type OcrSyncStop = (typeof OCR_SYNC_STOP)[keyof typeof OCR_SYNC_STOP]

export type OcrSyncReport = { stop: OcrSyncStop; tally: OcrSyncTally }

/** Thrown inside a drain to unwind to its top with a reason. */
class DrainStop extends Error {
  constructor(readonly stop: OcrSyncStop) {
    super(stop)
    this.name = "DrainStop"
  }
}

export function createOcrSyncDrainer(ports: OcrSyncPorts, limits: OcrSyncLimits) {
  const state = { running: false, rerun: false }
  const pause = { until: 0, failures: 0 }

  function tallyPlan(tally: OcrSyncTally, plan: OcrSyncWritePlan): void {
    tally.available += plan.available.length
    tally.building += plan.building.length
    tally.unavailable += plan.unavailable.length
  }

  async function reject(
    ark: string,
    message: string,
    tally: OcrSyncTally,
    signal: AbortSignal,
  ): Promise<void> {
    ports.error(`${ark} breaks the worker contract`, message)
    await ports.recordRejection(ark, message, new Date(ports.now()), signal)
    tally.rejected += 1
  }

  async function syncIsolating(
    arks: string[],
    tally: OcrSyncTally,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      tallyPlan(tally, await ports.syncBatch(arks, signal))
      if (pause.failures > 0) {
        ports.log(`worker answers validly again after ${pause.failures} exchange failure(s); sync resumed`)
        pause.failures = 0
        pause.until = 0
      }
      return
    } catch (err) {
      if (signal.aborted) throw new DrainStop(OCR_SYNC_STOP.DEADLINE)
      if (err instanceof OcrSyncUnavailableError) {
        ports.error(`batch of ${arks.length} unanswered (${arks.join(", ")})`, err)
        await ports.recordUnavailable(arks, err.message, new Date(ports.now()), signal)
        tally.outage += arks.length
        throw new DrainStop(OCR_SYNC_STOP.WORKER_UNAVAILABLE)
      }
      if (!(err instanceof OcrSyncContractError)) {
        ports.error(`batch of ${arks.length} failed (${arks.join(", ")})`, err)
        throw err
      }
      if (err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE) {
        pause.failures += 1
        const backoff = exchangeBackoffMs(pause.failures)
        pause.until = ports.now() + backoff
        ports.error(
          `the worker's answer breaks the contract for the whole exchange; sync paused for ${backoff} ms`,
          err,
        )
        throw new DrainStop(OCR_SYNC_STOP.EXCHANGE_PAUSED)
      }
      const culprits = err.culprits.filter((c) => arks.includes(c))
      if (culprits.length > 0) {
        for (const ark of culprits) await reject(ark, err.message, tally, signal)
        const rest = arks.filter((a) => !culprits.includes(a))
        if (rest.length > 0) await syncIsolating(rest, tally, signal)
        return
      }
      const [only] = arks
      if (arks.length === 1 && only !== undefined) {
        await reject(only, err.message, tally, signal)
        return
      }
      for (const half of splitBatch(arks)) await syncIsolating(half, tally, signal)
    }
  }

  async function sweep(deadline: number, signal: AbortSignal, tally: OcrSyncTally): Promise<OcrSyncStop> {
    if (ports.now() < pause.until) return OCR_SYNC_STOP.EXCHANGE_PAUSED
    const corpora = await ports.pendingByCorpus(new Date(ports.now()), signal)
    let batches = 0
    for (const { corpusProjectId, pending } of corpora) {
      if (pending === 0) continue
      for (;;) {
        if (batches >= limits.maxBatches) return OCR_SYNC_STOP.BUDGET
        if (remainingMs(deadline, ports.now()) < ports.batchCostMs()) return OCR_SYNC_STOP.BUDGET
        const arks = await ports.pendingArks(
          corpusProjectId,
          limits.batchSize,
          new Date(ports.now()),
          signal,
        )
        if (arks.length === 0) break
        await syncIsolating(arks, tally, signal)
        batches += 1
        if (arks.length < limits.batchSize) break
      }
    }
    return OCR_SYNC_STOP.DONE
  }

  /**
   * Run one drain, or fold into the running one (which sweeps again). Resolves
   * with why it stopped; rejects only on an unexpected failure (a DB error),
   * already logged.
   */
  async function drain(lifecycle: AbortSignal): Promise<OcrSyncReport> {
    const tally: OcrSyncTally = { available: 0, building: 0, unavailable: 0, rejected: 0, outage: 0 }
    if (state.running) {
      state.rerun = true
      return { stop: OCR_SYNC_STOP.COALESCED, tally }
    }
    state.running = true
    const deadline = ports.now() + limits.drainDeadlineMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limits.drainDeadlineMs)
    const signal = AbortSignal.any([controller.signal, lifecycle])
    try {
      let stop: OcrSyncStop = OCR_SYNC_STOP.DONE
      do {
        state.rerun = false
        try {
          stop = await sweep(deadline, signal, tally)
        } catch (err) {
          if (err instanceof DrainStop) {
            stop = err.stop
            break
          }
          if (signal.aborted && (err instanceof DeadlineExceededError || isAbortError(err))) {
            stop = OCR_SYNC_STOP.DEADLINE
            break
          }
          throw err
        }
      } while (state.rerun && stop === OCR_SYNC_STOP.DONE && !signal.aborted)
      return { stop, tally }
    } finally {
      clearTimeout(timer)
      state.running = false
    }
  }

  return { drain, isRunning: () => state.running, pausedUntil: () => pause.until }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------

function boundedRead<T>(label: string, work: Promise<T>, signal: AbortSignal): Promise<T> {
  return withDeadline(work, { label: `[ocr-sync] ${label}`, ms: OCR_DB_TIMEOUT_MS, signal })
}

const realPorts: OcrSyncPorts = {
  pendingByCorpus: (now, signal) =>
    boundedRead("pending corpora", DocumentQueries.ocrPendingByCorpus(now), signal),
  pendingArks: (corpusProjectId, limit, now, signal) =>
    boundedRead(
      `pending ARKs of ${corpusProjectId}`,
      DocumentQueries.pendingOcrArks({ corpusProjectId, limit, now }),
      signal,
    ),
  syncBatch: (arks, signal) => DocumentService.syncOcrBatch(arks, signal),
  recordRejection: (ark, message, now, signal) =>
    DocumentService.recordOcrRejection(ark, message, now, signal),
  recordUnavailable: (arks, message, now, signal) =>
    DocumentService.recordOcrUnavailable(arks, message, now, signal),
  batchCostMs: () => workerRequestTimeoutMs() + OCR_SYNC_BATCH_WRITE_MARGIN_MS,
  now: () => Date.now(),
  log: (message) => console.log(`[ocr-sync] ${message}`),
  error: (message, err) => console.error(`[ocr-sync] ${message}:`, err),
}

const drainer = createOcrSyncDrainer(realPorts, {
  drainDeadlineMs: OCR_SYNC_DRAIN_DEADLINE_MS,
  batchSize: OCR_SYNC_BATCH_SIZE,
  maxBatches: OCR_SYNC_MAX_BATCHES_PER_CYCLE,
})

const lifecycle: { controller: AbortController; stop: (() => void) | null } = {
  controller: new AbortController(),
  stop: null,
}

function syncEnabled(): boolean {
  return clusterMode() === CLUSTER_MODE.REAL
}

async function runDrain(trigger: string): Promise<void> {
  const report = await drainer.drain(lifecycle.controller.signal)
  if (report.stop === OCR_SYNC_STOP.COALESCED) return
  const { tally } = report
  const moved = tally.available + tally.building + tally.unavailable + tally.rejected + tally.outage
  if (moved === 0 && report.stop === OCR_SYNC_STOP.DONE) return
  realPorts.log(
    `cycle (${trigger}): available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}, rejected=${tally.rejected}, outage=${tally.outage}, stop=${report.stop}`,
  )
}

/** Drain whatever is due now. Throws what the drain threw; the caller logs it. */
export async function resumePendingOcrSync(): Promise<void> {
  if (!syncEnabled()) return
  await runDrain("sweep")
}

/**
 * Boot resume + periodic sweep + the commit signal (instrumentation.ts).
 * Returns a stop handle that clears the timer, unsubscribes the signal and
 * aborts an in-flight drain at its next cancellation point. The timer is
 * unref'd so it never holds the process open; a second start (dev hot-reload
 * re-running register()) replaces the first. One log line and nothing else
 * outside real mode.
 */
export function startOcrSync(): { stop: () => void } {
  if (!syncEnabled()) {
    realPorts.log("disabled: CLUSTER_MODE is not real (no worker artifacts to sync)")
    return { stop: () => {} }
  }
  lifecycle.stop?.()
  lifecycle.controller = new AbortController()
  const kick = (trigger: string) => {
    void runDrain(trigger).catch((err: unknown) => {
      realPorts.error(`${trigger} drain failed`, err)
    })
  }
  kick("boot")
  const timer = setInterval(() => kick("sweep"), OCR_SYNC_SWEEP_INTERVAL_MS)
  timer.unref()
  const unsubscribe = onOcrSyncRequested(() => kick("commit"))
  const controller = lifecycle.controller
  const stop = () => {
    clearInterval(timer)
    unsubscribe()
    controller.abort()
    if (lifecycle.stop === stop) lifecycle.stop = null
  }
  lifecycle.stop = stop
  return { stop }
}
