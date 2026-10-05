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
// round-robin over the corpora (one batch per corpus per round, corpora with
// resync requests first; inside a corpus resync-requested ARKs first, then
// never-asked, then cited) so a large backfill in one corpus never starves
// another corpus's fresh commit; it is also what drives the backfill of
// documents indexed before the feature. A commit nudges it through
// lib/documents/ocr-sync-signal.ts (IngestService never imports this module).
//
// Failure handling (CLAUDE_ERROR_PATTERNS §10/§14):
//   - OcrSyncUnavailableError (worker unreachable, timeout, 5xx, old worker):
//     the batch's rows back off (OCR_SYNC_OUTAGE_BACKOFF_MS) without touching
//     their contract budget or status; a never-asked ARK stays pending (no
//     row) and only that corpus's turn ends. A batch whose ARKs ALL failed an
//     outage before (per-ARK counts, never-asked ARKs included) is split and
//     BOTH halves asked, recursing to single ARKs within
//     OCR_SYNC_OUTAGE_BISECT_BUDGET requests per drain: a single ARK that
//     fails sits out OCR_SYNC_OUTAGE_BACKOFF_MS, and after
//     OCR_SYNC_MAX_ATTEMPTS such failures is isolated (quarantined; a resync
//     re-opens it) — its batch-mates are served meanwhile.
//   - OcrSyncContractError on the EXCHANGE (version skew, 401/403/413, a body
//     that is not a sync answer): the SYNC pauses with an exponential backoff,
//     no ARK is penalised, and the first valid answer resumes it.
//   - OcrSyncContractError on ARKS: named culprits are rejected (backoff, then
//     quarantine after OCR_SYNC_MAX_ATTEMPTS) and the rest of the batch is asked
//     again; unnamed ones are found by bisecting the batch.
//   - one AbortController per drain, fired at OCR_SYNC_DRAIN_DEADLINE_MS,
//     cancels the in-flight request and stops the writes between ARKs; no
//     request — batch or bisected sub-batch — starts unless its worst-case cost
//     still fits; every read is bounded by
//     OCR_DB_TIMEOUT_MS. The running guard is released only once the work has
//     actually stopped.
//
// Layering: a background drainer is the second kind of entry point the
// playbook allows to call services (playbook/api-layers.md, "Background
// drainers"): writes through DocumentService, reads through DocumentQueries,
// never Prisma itself. A no-op unless CLUSTER_MODE=real.
import "server-only"

import { DeadlineExceededError, withDeadline } from "@/lib/async/deadline"
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
  OCR_SYNC_MAX_ATTEMPTS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_OUTAGE_BACKOFF_MS,
  OCR_SYNC_OUTAGE_BISECT_BUDGET,
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
  ): Promise<Array<{ corpusProjectId: string; pending: number; resync: number }>>
  pendingArks(corpusProjectId: string, limit: number, now: Date, signal: AbortSignal): Promise<string[]>
  syncBatch(arks: string[], signal: AbortSignal): Promise<OcrSyncWritePlan>
  /** `askedAt`: when the failing question was asked (a resync made after it stays due). */
  recordRejection(ark: string, message: string, now: Date, askedAt: Date, signal: AbortSignal): Promise<void>
  recordOutage(arks: string[], now: Date, signal: AbortSignal): Promise<void>
  /** Take an ARK the worker reliably fails on ALONE out of the rotation (quarantine; a resync re-opens it). */
  recordIsolation(ark: string, message: string, now: Date, signal: AbortSignal): Promise<void>
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
  /** Requests one drain may spend bisecting batches that keep failing on an outage. */
  outageBisectBudget: number
  /** Singleton outages after which an ARK is isolated (OCR_SYNC_MAX_ATTEMPTS). */
  maxAttempts: number
  /** How long an ARK whose singleton failed an outage sits out, in memory. */
  outageBackoffMs: number
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

/** Thrown inside a drain to unwind to its top with a reason (the whole drain stops). */
class DrainStop extends Error {
  constructor(readonly stop: OcrSyncStop) {
    super(stop)
    this.name = "DrainStop"
  }
}

export function createOcrSyncDrainer(ports: OcrSyncPorts, limits: OcrSyncLimits) {
  const state = { running: false, rerun: false }
  const pause = { until: 0, failures: 0 }
  /**
   * The drainer's memory across drains (it lives with the drainer on the
   * global lifecycle symbol). Process-local by design: a restart forgets it
   * and loses at most one drain's worth of isolation work.
   *   outages — per-ARK count of outages the ARK was part of, never-asked
   *             ARKs included (they have no row to back off); cleared when
   *             the ARK is answered;
   *   benched — ARKs whose SINGLETON failed an outage, sitting out until a
   *             time (no row holds their backoff);
   *   cursor  — the last corpus served, so the next sweep resumes after it.
   */
  const memory: { outages: Map<string, number>; benched: Map<string, number>; cursor: string | null } = {
    outages: new Map(),
    benched: new Map(),
    cursor: null,
  }
  const MEMORY_MAX = 10_000

  function tallyPlan(tally: OcrSyncTally, plan: OcrSyncWritePlan): void {
    tally.available += plan.available.length
    tally.building += plan.building.length
    tally.unavailable += plan.unavailable.length
  }

  async function reject(
    ark: string,
    message: string,
    askedAt: Date,
    tally: OcrSyncTally,
    signal: AbortSignal,
  ): Promise<void> {
    ports.error(`${ark} breaks the worker contract`, message)
    await ports.recordRejection(ark, message, new Date(ports.now()), askedAt, signal)
    tally.rejected += 1
  }

  /** One drain's limits as they are spent: requests made, bisection requests left, the deadline. */
  type Spend = { deadline: number; batches: number; bisects: number }

  /** Every request — a batch or a sub-batch — must still fit the drain's deadline. */
  function assertBatchFits(spend: Spend): void {
    if (remainingMs(spend.deadline, ports.now()) < ports.batchCostMs()) {
      throw new DrainStop(OCR_SYNC_STOP.BUDGET)
    }
  }

  function noteOutage(arks: string[]): void {
    if (memory.outages.size > MEMORY_MAX) memory.outages.clear()
    for (const ark of arks) memory.outages.set(ark, (memory.outages.get(ark) ?? 0) + 1)
  }

  /**
   * Ask about `arks`. On an outage that repeats for every ARK of the batch,
   * ask BOTH halves (recursing to single ARKs within the drain's bisection
   * budget) so a poison ARK is cornered and its batch-mates served; returns
   * whether an unbisected outage was hit (the caller ends the corpus's turn).
   */
  async function syncIsolating(
    arks: string[],
    tally: OcrSyncTally,
    signal: AbortSignal,
    spend: Spend,
  ): Promise<"answered" | "outage"> {
    assertBatchFits(spend)
    const askedAt = new Date(ports.now())
    try {
      tallyPlan(tally, await ports.syncBatch(arks, signal))
      for (const ark of arks) memory.outages.delete(ark)
      if (pause.failures > 0) {
        ports.log(`worker answers validly again after ${pause.failures} exchange failure(s); sync resumed`)
        pause.failures = 0
        pause.until = 0
      }
      return "answered"
    } catch (err) {
      if (signal.aborted) throw new DrainStop(OCR_SYNC_STOP.DEADLINE)
      if (err instanceof OcrSyncUnavailableError) {
        const repeated = arks.every((a) => (memory.outages.get(a) ?? 0) > 0)
        noteOutage(arks)
        if (repeated && arks.length > 1 && spend.bisects >= 2) {
          spend.bisects -= 2
          ports.log(`batch of ${arks.length} failed an outage again; asking both halves`)
          let outcome: "answered" | "outage" = "answered"
          for (const half of splitBatch(arks)) {
            if ((await syncIsolating(half, tally, signal, spend)) === "outage") outcome = "outage"
          }
          return outcome
        }
        const [only] = arks
        if (arks.length === 1 && only !== undefined) await sideline(only, err, signal)
        ports.error(`batch of ${arks.length} unanswered (${arks.join(", ")})`, err)
        await ports.recordOutage(arks, new Date(ports.now()), signal)
        tally.outage += arks.length
        return "outage"
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
        for (const ark of culprits) await reject(ark, err.message, askedAt, tally, signal)
        const rest = arks.filter((a) => !culprits.includes(a))
        if (rest.length > 0) return syncIsolating(rest, tally, signal, spend)
        return "answered"
      }
      const [only] = arks
      if (arks.length === 1 && only !== undefined) {
        await reject(only, err.message, askedAt, tally, signal)
        return "answered"
      }
      let outcome: "answered" | "outage" = "answered"
      for (const half of splitBatch(arks)) {
        if ((await syncIsolating(half, tally, signal, spend)) === "outage") outcome = "outage"
      }
      return outcome
    }
  }

  /**
   * A single ARK the worker failed on: it sits out (benched, in memory) for
   * outageBackoffMs; once its singleton has failed maxAttempts times it is
   * isolated for good (a quarantine a resync re-opens).
   */
  async function sideline(ark: string, err: Error, signal: AbortSignal): Promise<void> {
    const count = memory.outages.get(ark) ?? 0
    if (count >= limits.maxAttempts) {
      memory.outages.delete(ark)
      memory.benched.delete(ark)
      ports.error(`${ark} isolated: the worker failed on it alone ${count} times`, err)
      await ports.recordIsolation(ark, err.message, new Date(ports.now()), signal)
      return
    }
    if (memory.benched.size > MEMORY_MAX) memory.benched.clear()
    memory.benched.set(ark, ports.now() + limits.outageBackoffMs)
  }

  function isBenched(ark: string): boolean {
    const until = memory.benched.get(ark)
    if (until === undefined) return false
    if (until > ports.now()) return true
    memory.benched.delete(ark)
    return false
  }

  /**
   * The rotation of one sweep: corpora with resync requests first, then the
   * others in a stable order resumed AFTER the last corpus served (memory.cursor),
   * so a cycle cap never starves the corpora at the end of the list.
   */
  function rotationOf(corpora: Array<{ corpusProjectId: string; pending: number; resync: number }>): string[] {
    const due = corpora.filter((c) => c.pending > 0)
    const resync = due.filter((c) => c.resync > 0).sort((x, y) => y.resync - x.resync)
    const rest = due
      .filter((c) => c.resync === 0)
      .map((c) => c.corpusProjectId)
      .sort()
    const cursor = memory.cursor
    const start = cursor === null ? 0 : rest.findIndex((id) => id > cursor)
    const resumed = start <= 0 ? rest : [...rest.slice(start), ...rest.slice(0, start)]
    return [...resync.map((c) => c.corpusProjectId), ...resumed]
  }

  /**
   * Round-robin: each round takes ONE batch from every corpus that still has
   * due ARKs, resuming after the last corpus served; a corpus leaves the
   * rotation once a batch comes back short or its turn ends on an outage.
   */
  async function sweep(deadline: number, signal: AbortSignal, tally: OcrSyncTally): Promise<OcrSyncStop> {
    if (ports.now() < pause.until) return OCR_SYNC_STOP.EXCHANGE_PAUSED
    const corpora = await ports.pendingByCorpus(new Date(ports.now()), signal)
    let rotation = rotationOf(corpora)
    const spend: Spend = { deadline, batches: 0, bisects: limits.outageBisectBudget }
    let turns = 0
    let outageTurns = 0
    while (rotation.length > 0) {
      const next: string[] = []
      for (const corpusProjectId of rotation) {
        if (spend.batches >= limits.maxBatches) return OCR_SYNC_STOP.BUDGET
        const due = await ports.pendingArks(corpusProjectId, limits.batchSize, new Date(ports.now()), signal)
        const arks = due.filter((a) => !isBenched(a))
        if (arks.length === 0) continue
        spend.batches += 1
        turns += 1
        memory.cursor = corpusProjectId
        if ((await syncIsolating(arks, tally, signal, spend)) === "outage") {
          outageTurns += 1
          continue // only this corpus's turn ends
        }
        if (due.length === limits.batchSize) next.push(corpusProjectId)
      }
      rotation = next
    }
    if (turns > 0 && outageTurns === turns) return OCR_SYNC_STOP.WORKER_UNAVAILABLE
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
  recordRejection: (ark, message, now, askedAt, signal) =>
    DocumentService.recordOcrRejection(ark, message, now, askedAt, signal),
  recordIsolation: (ark, message, now, signal) => DocumentService.recordOcrIsolation(ark, message, now, signal),
  recordOutage: (arks, now, signal) => DocumentService.recordOcrOutage(arks, now, signal),
  batchCostMs: () => DocumentService.ocrSyncRequestTimeoutMs() + OCR_SYNC_BATCH_WRITE_MARGIN_MS,
  now: () => Date.now(),
  log: (message) => console.log(`[ocr-sync] ${message}`),
  error: (message, err) => console.error(`[ocr-sync] ${message}:`, err),
}

/**
 * The drainer's whole lifecycle — the drainer (and so its running guard,
 * pause and outage memory), the abort controller and the stop handle — lives
 * on globalThis under a registered symbol: Next.js may evaluate this module
 * more than once (instrumentation and route bundles, dev re-evaluation), and a
 * second module copy must find and REPLACE the one drainer, never start a
 * second one beside it.
 */
type OcrSyncLifecycle = {
  drain: (lifecycle: AbortSignal) => Promise<OcrSyncReport>
  controller: AbortController
  stop: (() => void) | null
}

const LIFECYCLE_KEY = Symbol.for("bnf.documents.ocr-sync-lifecycle")

function isLifecycle(v: unknown): v is OcrSyncLifecycle {
  return (
    typeof v === "object" &&
    v !== null &&
    "drain" in v &&
    typeof v.drain === "function" &&
    "controller" in v &&
    v.controller instanceof AbortController &&
    "stop" in v
  )
}

function lifecycle(): OcrSyncLifecycle {
  const existing: unknown = Reflect.get(globalThis, LIFECYCLE_KEY)
  if (isLifecycle(existing)) return existing
  const created: OcrSyncLifecycle = {
    drain: createOcrSyncDrainer(realPorts, {
      drainDeadlineMs: OCR_SYNC_DRAIN_DEADLINE_MS,
      batchSize: OCR_SYNC_BATCH_SIZE,
      maxBatches: OCR_SYNC_MAX_BATCHES_PER_CYCLE,
      outageBisectBudget: OCR_SYNC_OUTAGE_BISECT_BUDGET,
      maxAttempts: OCR_SYNC_MAX_ATTEMPTS,
      outageBackoffMs: OCR_SYNC_OUTAGE_BACKOFF_MS,
    }).drain,
    controller: new AbortController(),
    stop: null,
  }
  Reflect.set(globalThis, LIFECYCLE_KEY, created)
  return created
}

function syncEnabled(): boolean {
  return clusterMode() === CLUSTER_MODE.REAL
}

async function runDrain(trigger: string): Promise<void> {
  const life = lifecycle()
  const report = await life.drain(life.controller.signal)
  if (report.stop === OCR_SYNC_STOP.COALESCED) return
  const { tally } = report
  const moved = tally.available + tally.building + tally.unavailable + tally.rejected + tally.outage
  if (moved === 0 && report.stop === OCR_SYNC_STOP.DONE) return
  realPorts.log(
    `cycle (${trigger}): available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}, rejected=${tally.rejected}, outage=${tally.outage}, stop=${report.stop}`,
  )
}

/**
 * Boot resume + periodic sweep + the commit signal (instrumentation.ts).
 * Returns a stop handle that clears the timer, unsubscribes the signal and
 * aborts an in-flight drain at its next cancellation point. The timer is
 * unref'd so it never holds the process open; a second start (dev hot-reload
 * re-running register(), or another copy of this module) stops the first
 * through the global lifecycle. One log line and nothing else outside real
 * mode.
 */
export function startOcrSync(): { stop: () => void } {
  if (!syncEnabled()) {
    realPorts.log("disabled: CLUSTER_MODE is not real (no worker artifacts to sync)")
    return { stop: () => {} }
  }
  const life = lifecycle()
  life.stop?.()
  life.controller = new AbortController()
  const kick = (trigger: string) => {
    void runDrain(trigger).catch((err: unknown) => {
      realPorts.error(`${trigger} drain failed`, err)
    })
  }
  kick("boot")
  const timer = setInterval(() => kick("sweep"), OCR_SYNC_SWEEP_INTERVAL_MS)
  timer.unref()
  const unsubscribe = onOcrSyncRequested(() => kick("commit"))
  const controller = life.controller
  const stop = () => {
    clearInterval(timer)
    unsubscribe()
    controller.abort()
    if (life.stop === stop) life.stop = null
  }
  life.stop = stop
  return { stop }
}
