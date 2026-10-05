// lib/documents/ocr-sync.ts
// OCR-quality sync drainer — pulls worker-v2's per-ARK `ocr-quality/<slug>.json`
// artifacts into DocumentOcr / DocumentFolio (feedback 2026-09-29 #7, Track B,
// plan D7: the app pulls; the terminal callback is not used).
//
// WHAT IS DUE is persisted, never held in memory: an indexed ARK with no
// DocumentOcr row, or a row whose `next_check_at` has passed (pending,
// building, unavailable, incompatible, backing off, or a re-ingest's resync
// request written in the commit's own transaction). The sweep (boot + every
// OCR_SYNC_SWEEP_INTERVAL_MS) drains it round-robin over the corpora, one
// batch per corpus per round, each tier resumed after the last corpus it
// served: corpora with resync requests first, but while other corpora wait
// at most half the drain's batch count of them start per drain, so neither
// tier starves the other. A commit nudges it through lib/documents/ocr-sync-signal.ts
// (IngestService never imports this module).
//
// FAILURES ARE TOLD APART BY EVIDENCE (CLAUDE_ERROR_PATTERNS §10/§14):
//   A. Transport (no answer, timeout, 5xx, 404, a body that is not JSON) says
//      nothing about any document and never counts against an ARK by itself.
//      A failed BATCH ends that corpus's turn and paces it (syncBackoffMs of
//      its consecutive failures, in memory — pacing only, a restart costs one
//      early request); each ARK's persisted `outage_count` goes up and a
//      never-asked ARK gets its `pending` row. An ARK whose count reached 2
//      (its batch failed twice) is asked ALONE, at most
//      OCR_SYNC_ISOLATION_BUDGET requests per drain (controls included); the
//      rest of its corpus goes on in batches without it. An ARK asked alone
//      earns an outage STRIKE only inside a BRACKET of evidence, in one drain:
//      an answer → it fails → two `available` CONTROLS answered back to back →
//      it fails again (a flapping worker cannot answer two requests in a row
//      on a period-2 pattern, nor after it died). Anything less only backs it
//      off. Controls rotate among the OCR_SYNC_CONTROL_POOL most recent
//      `available` ARKs with no outage on record; a control that fails is an
//      ordinary lone failure of that ARK and ends the isolation for the drain.
//      At OCR_SYNC_MAX_ATTEMPTS strikes the ARK is quarantined
//      (`worker_fails_alone`) — a long backoff (24 h doubling to 7 days),
//      healed by any answer, re-opened at once by a re-ingest's resync. A
//      worker outage costs one control per drain and blames nobody.
//   B. Contract, decided per document by the artifact's own `v` (see
//      lib/cluster/ocr-quality.ts): another `v` → `incompatible` (a deploy
//      mismatch: nobody blamed, asked again in 24 h, logged at error level
//      once per drain with both versions; the deploy that fixes it re-asks them
//      at boot); the expected `v` failing its schema → that ARK alone is
//      rejected (backoff, then the long quarantine backoff `sync_rejected`
//      from OCR_SYNC_MAX_ATTEMPTS) and the sync goes on. An `available` row
//      keeps its folios through `building` / `unavailable` answers (a worker
//      rebuilding after a bump) until a new `available` or `incompatible` one. A 400 naming an ARK,
//      or ARKs left out of an otherwise answered batch, are rejected the same
//      way and the rest asked again. Only an exchange-level break (401/403/413,
//      an envelope that does not parse, an answer to nothing asked) pauses the
//      WHOLE sync (syncBackoffMs); the first answer resumes it.
//   C. Every write of a failure carries `askedAt` and is a compare-and-set on
//      the row as read, stamping `checked_at` past `askedAt`: evidence recorded
//      after the question supersedes it, two drainers (replicas, a rolling
//      update) record one failure once, and a resync requested after it keeps
//      the ARK due whatever the failure says.
//   D. One AbortController per drain, fired at OCR_SYNC_DRAIN_DEADLINE_MS,
//      cancels the in-flight request and stops the writes between ARKs; no
//      request starts unless its worst-case cost still fits; every read is
//      bounded by OCR_DB_TIMEOUT_MS. The running guard is released only once
//      the work has actually stopped.
//
// Layering: a background drainer is the second kind of entry point the
// playbook allows to call services (playbook/api-layers.md, "Background
// drainers"): writes through DocumentService, reads through DocumentQueries,
// never Prisma itself. A no-op unless CLUSTER_MODE=real.
import "server-only"

import { DeadlineExceededError, withDeadline } from "@/lib/async/deadline"
import { CLUSTER_MODE, clusterMode } from "@/lib/cluster/mode"
import {
  OCR_QUALITY_ARTIFACT_VERSION,
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
} from "@/lib/cluster/ocr-quality"
import {
  OCR_DB_TIMEOUT_MS,
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_BATCH_WRITE_MARGIN_MS,
  OCR_SYNC_CONTROL_POOL,
  OCR_SYNC_DRAIN_DEADLINE_MS,
  OCR_SYNC_ISOLATION_BUDGET,
  OCR_SYNC_MAX_ATTEMPTS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_SWEEP_INTERVAL_MS,
} from "@/lib/constants"
import { DocumentQueries } from "@/models/documents/queries"
import type { OcrSyncBatchResult } from "@/models/documents/schema"
import {
  DocumentService,
  OCR_ALONE_OUTCOME,
  type OcrAloneOutcome,
  syncBackoffMs,
} from "@/models/documents/service"

import { onOcrSyncRequested } from "./ocr-sync-signal"

/** Milliseconds left before `deadline`, never negative. */
export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now)
}

/** An ARK's outage count from which it is asked alone (its batch failed on the transport twice). */
export const OCR_SYNC_ALONE_FROM = 2

// ---------------------------------------------------------------------------
// The drainer core — I/O through ports, so its behaviour is tested
// (tests/models/documents/ocr-sync.test.ts).
// ---------------------------------------------------------------------------

export type OcrSyncPorts = {
  pendingByCorpus(
    now: Date,
    signal: AbortSignal,
  ): Promise<Array<{ corpusProjectId: string; pending: number; resync: number }>>
  pendingArks(
    corpusProjectId: string,
    limit: number,
    now: Date,
    signal: AbortSignal,
  ): Promise<Array<{ ark: string; outageCount: number }>>
  /** Up to `limit` `available` ARKs outside `exclude` to rotate as controls (most recent first). */
  controlArks(exclude: string[], limit: number, signal: AbortSignal): Promise<string[]>
  syncBatch(arks: string[], signal: AbortSignal): Promise<OcrSyncBatchResult>
  /** `askedAt`: when the rejected question was asked; resolves false when nothing was written. */
  recordRejection(ark: string, message: string, now: Date, askedAt: Date, signal: AbortSignal): Promise<boolean>
  recordBatchOutage(arks: string[], askedAt: Date, signal: AbortSignal): Promise<void>
  recordAloneFailure(
    ark: string,
    message: string,
    opts: { askedAt: Date; now: Date; bracketed: boolean },
    signal: AbortSignal,
  ): Promise<{ outcome: OcrAloneOutcome; strikes: number }>
  /** Worst-case cost of one request (request timeout + write margin). */
  batchCostMs(): number
  now(): number
  log(message: string): void
  /** Evidence about one ARK that is not (yet) a fault: strikes, lone failures, lost writes. */
  warn(message: string, err: unknown): void
  error(message: string, err: unknown): void
}

export type OcrSyncLimits = {
  drainDeadlineMs: number
  batchSize: number
  maxBatches: number
  /** Requests one drain may spend asking ARKs alone, the control included. */
  isolationBudget: number
  /** Strikes (and rejections) at which an ARK is quarantined — for the log lines. */
  maxAttempts: number
  /** How many recent `available` ARKs the control rotates among. */
  controlPool: number
}

export type OcrSyncTally = {
  available: number
  building: number
  unavailable: number
  /** ARKs whose artifact is another version than the app reads. */
  incompatible: number
  /** ARKs whose answer was rejected this drain (backed off or quarantined). */
  rejected: number
  /** ARKs of requests that failed on the transport. */
  outage: number
  /** Outage strikes given this drain (quarantines included). */
  struck: number
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

/** The outcome of one request: answered, or failed on the transport (the caller decides). */
type Asked = { kind: "answered" } | { kind: "transport"; askedAt: Date; err: OcrSyncUnavailableError }

/** One drain's spend and evidence. */
type Drain = {
  deadline: number
  signal: AbortSignal
  tally: OcrSyncTally
  batches: number
  isolation: number
  /** A request of this drain was answered (the drain did not end on a down worker). */
  controlled: boolean
  /** Requests that failed on the transport / that were made. */
  failures: number
  requests: number
  /** Incompatible artifacts seen, by worker version — logged once at the end. */
  skew: Map<number, string[]>
}

export function createOcrSyncDrainer(ports: OcrSyncPorts, limits: OcrSyncLimits) {
  const state = { running: false, rerun: false }
  const pause = { until: 0, failures: 0 }
  /**
   * Pacing and fairness only — never evidence about an ARK (that is
   * persisted): a restart forgets them and costs at most one early request
   * per corpus and one reshuffled rotation.
   *   paced  — per corpus, consecutive batch transport failures and when its
   *            next turn may come; pruned to the corpora that have work due;
   *   cursor — the last corpus each tier served, and the control rotation.
   */
  const paced = new Map<string, { failures: number; until: number }>()
  const cursor: { resync: string | null; rest: string | null; control: number } = {
    resync: null,
    rest: null,
    control: 0,
  }

  /** Every request must still fit the drain's deadline. */
  function assertFits(d: Drain): void {
    if (remainingMs(d.deadline, ports.now()) < ports.batchCostMs()) throw new DrainStop(OCR_SYNC_STOP.BUDGET)
  }

  function answered(d: Drain): void {
    d.controlled = true
    if (pause.failures > 0) {
      ports.log(`worker answers validly again after ${pause.failures} exchange failure(s); sync resumed`)
      pause.failures = 0
      pause.until = 0
    }
  }

  async function reject(ark: string, message: string, askedAt: Date, d: Drain): Promise<void> {
    if (await ports.recordRejection(ark, message, new Date(ports.now()), askedAt, d.signal)) {
      ports.error(`${ark}: the worker's answer for it is rejected`, message)
      d.tally.rejected += 1
      return
    }
    ports.warn(`${ark}: rejection not recorded — newer evidence, or another drainer recorded it first`, message)
  }

  /**
   * Ask about `arks` once (plus, on a 400 naming some of them, the rest
   * again). Answers are written by the service; broken artifacts and named
   * ARKs are rejected one by one; an exchange-level break pauses the sync
   * and stops the drain. A transport failure is returned to the caller,
   * which alone knows what it means (a batch, an ARK alone, a control).
   */
  async function ask(arks: string[], d: Drain): Promise<Asked> {
    assertFits(d)
    const askedAt = new Date(ports.now())
    d.requests += 1
    try {
      const { plan, broken } = await ports.syncBatch(arks, d.signal)
      answered(d)
      d.tally.available += plan.available.length
      d.tally.building += plan.building.length
      d.tally.unavailable += plan.unavailable.length
      d.tally.incompatible += plan.incompatible.length
      for (const { ark, v } of plan.incompatible) d.skew.set(v, [...(d.skew.get(v) ?? []), ark])
      for (const { ark, message } of broken) await reject(ark, message, plan.checkedAt, d)
      return { kind: "answered" }
    } catch (err) {
      if (d.signal.aborted) throw new DrainStop(OCR_SYNC_STOP.DEADLINE)
      if (err instanceof OcrSyncUnavailableError) {
        d.failures += 1
        d.tally.outage += arks.length
        return { kind: "transport", askedAt, err }
      }
      if (!(err instanceof OcrSyncContractError)) {
        ports.error(`request of ${arks.length} ARK(s) failed (${arks.join(", ")})`, err)
        throw err
      }
      const culprits = err.culprits.filter((c) => arks.includes(c))
      if (err.scope === OCR_SYNC_FAULT_SCOPE.EXCHANGE || culprits.length === 0) {
        pause.failures += 1
        const backoff = syncBackoffMs(pause.failures)
        pause.until = ports.now() + backoff
        ports.error(`the worker's answer breaks the contract as a whole; sync paused for ${backoff} ms`, err)
        throw new DrainStop(OCR_SYNC_STOP.EXCHANGE_PAUSED)
      }
      // The worker answered (a 400 naming ARKs, or a batch answered but for
      // some ARKs): it is up, the named ARKs are at fault.
      answered(d)
      for (const ark of culprits) await reject(ark, err.message, askedAt, d)
      const rest = arks.filter((a) => !culprits.includes(a))
      return rest.length > 0 ? ask(rest, d) : { kind: "answered" }
    }
  }

  /**
   * The ARKs to ask alone, in the order collected, within the isolation
   * budget. A strike needs a BRACKET, all in this drain and in this order:
   *   an answer (a control, or the previous ARK asked alone)
   *   → X fails → a control answered → a second control answered → X fails.
   * Two controls in the middle, back to back, because a worker that answers
   * every other request (or dies after one) would otherwise frame X: a
   * period-2 failure pattern cannot answer two consecutive requests. A
   * failure without a full bracket only backs X off. A control that fails is
   * recorded as an ordinary lone failure of that ARK and ends the isolation
   * for this drain (the worker is not proven up). With no control to ask
   * (nothing `available` yet), ARKs are still asked alone — their answers
   * serve the corpus and become the openers — but two transport failures in a
   * row end the isolation.
   */
  async function isolate(alone: string[], d: Drain): Promise<void> {
    let controls: string[] | null = null
    let lastAnswered = false
    let failuresInARow = 0
    /** Ask the next control: "answered", "failed" (the worker is not proven up), or "none". */
    const control = async (): Promise<"answered" | "failed" | "none"> => {
      if (d.isolation <= 0) return "none"
      if (controls === null) controls = await ports.controlArks(alone, limits.controlPool, d.signal)
      const pick = controls[cursor.control % Math.max(1, controls.length)]
      if (pick === undefined) return "none"
      cursor.control += 1
      d.isolation -= 1
      const result = await ask([pick], d)
      if (result.kind === "answered") return "answered"
      controls = controls.filter((c) => c !== pick)
      await lone(pick, result, false, d)
      return "failed"
    }
    for (const ark of alone) {
      if (d.isolation <= 0) return
      if (failuresInARow >= 2) {
        ports.log(`stopped asking ARKs alone this drain: ${failuresInARow} transport failures in a row`)
        return
      }
      if (!lastAnswered) {
        const opener = await control()
        if (opener === "failed") return
        if (opener === "answered") failuresInARow = 0
        if (d.isolation <= 0) return
      }
      d.isolation -= 1
      const first = await ask([ark], d)
      if (first.kind === "answered") {
        lastAnswered = true
        failuresInARow = 0
        continue
      }
      lastAnswered = false
      failuresInARow += 1
      // The middle of the bracket: two answered controls back to back.
      const middle = d.isolation >= 3 ? await control() : "none"
      const middle2 = middle === "answered" ? await control() : middle
      if (middle2 !== "answered") {
        await lone(ark, first, false, d)
        if (middle === "failed" || middle2 === "failed") return
        continue
      }
      failuresInARow = 0
      d.isolation -= 1
      const second = await ask([ark], d)
      if (second.kind === "answered") {
        lastAnswered = true
        continue
      }
      await lone(ark, second, true, d)
    }
  }

  /** Record a transport failure of `ark` asked alone; `bracketed` = it earns a strike. */
  async function lone(
    ark: string,
    failure: { askedAt: Date; err: OcrSyncUnavailableError },
    bracketed: boolean,
    d: Drain,
  ): Promise<void> {
    const { outcome, strikes } = await ports.recordAloneFailure(
      ark,
      failure.err.message,
      { askedAt: failure.askedAt, now: new Date(ports.now()), bracketed },
      d.signal,
    )
    if (outcome === OCR_ALONE_OUTCOME.STRUCK || outcome === OCR_ALONE_OUTCOME.QUARANTINED) {
      d.tally.struck += 1
      const verdict =
        outcome === OCR_ALONE_OUTCOME.QUARANTINED
          ? "quarantined (worker_fails_alone, rechecked in 24 h)"
          : "backing off"
      ports.warn(
        `${ark}: outage strike ${strikes}/${limits.maxAttempts}, ${verdict} — it failed alone twice, each time right after answered controls`,
        failure.err,
      )
      return
    }
    if (outcome === OCR_ALONE_OUTCOME.STALE) {
      ports.warn(`${ark}: lone failure not recorded — newer evidence, or another drainer recorded it first`, failure.err)
      return
    }
    ports.warn(`${ark}, asked alone, unanswered (no bracket of answered controls: no strike)`, failure.err)
  }

  /**
   * The rotation of one sweep: corpora with resync requests first — while
   * other corpora wait, only ceil(maxBatches / 2) of them start this sweep —
   * then the others; each tier in a stable order resumed after the last
   * corpus it started.
   */
  function rotationOf(
    corpora: Array<{ corpusProjectId: string; pending: number; resync: number }>,
  ): Array<{ corpusProjectId: string; resync: boolean }> {
    const due = corpora.filter((c) => c.pending > 0)
    const resumed = (ids: string[], after: string | null): string[] => {
      const sorted = [...ids].sort()
      const start = after === null ? -1 : sorted.findIndex((id) => id > after)
      return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)]
    }
    const resync = resumed(due.filter((c) => c.resync > 0).map((c) => c.corpusProjectId), cursor.resync)
    const rest = resumed(due.filter((c) => c.resync === 0).map((c) => c.corpusProjectId), cursor.rest)
    const resyncTurns = rest.length > 0 ? Math.ceil(limits.maxBatches / 2) : resync.length
    return [
      ...resync.slice(0, resyncTurns).map((corpusProjectId) => ({ corpusProjectId, resync: true })),
      ...rest.map((corpusProjectId) => ({ corpusProjectId, resync: false })),
    ]
  }

  /** One corpus's turn: its batch, or — when it has ARKs to ask alone — those, for later. */
  async function turn(
    corpusProjectId: string,
    alone: string[],
    d: Drain,
  ): Promise<"again" | "done"> {
    const due = await ports.pendingArks(corpusProjectId, limits.batchSize, new Date(ports.now()), d.signal)
    // ARKs whose batch failed twice are asked alone (later this drain); the
    // rest of the corpus is still asked as a batch — without them, so a
    // poison never rides in a batch again.
    const lone = due.filter((a) => a.outageCount >= OCR_SYNC_ALONE_FROM).map((a) => a.ark)
    for (const ark of lone) if (!alone.includes(ark)) alone.push(ark)
    const arks = due.filter((a) => a.outageCount < OCR_SYNC_ALONE_FROM).map((a) => a.ark)
    if (arks.length === 0) return "done"
    d.batches += 1
    const result = await ask(arks, d)
    if (result.kind === "answered") {
      paced.delete(corpusProjectId)
      return due.length === limits.batchSize ? "again" : "done"
    }
    const failures = (paced.get(corpusProjectId)?.failures ?? 0) + 1
    const backoff = syncBackoffMs(failures)
    paced.set(corpusProjectId, { failures, until: ports.now() + backoff })
    await ports.recordBatchOutage(arks, result.askedAt, d.signal)
    ports.error(
      `batch of ${arks.length} unanswered (corpus ${corpusProjectId}); its turn is paced for ${backoff} ms`,
      result.err,
    )
    return "done"
  }

  /**
   * Round-robin: each round takes ONE turn from every corpus that still has
   * due ARKs; a corpus leaves the rotation once a batch comes back short, it
   * has ARKs to ask alone, or its batch failed on the transport. The ARKs to
   * ask alone go last, so the batches can prove the worker up first.
   */
  async function sweep(d: Drain): Promise<OcrSyncStop> {
    if (ports.now() < pause.until) return OCR_SYNC_STOP.EXCHANGE_PAUSED
    const corpora = await ports.pendingByCorpus(new Date(ports.now()), d.signal)
    const withWork = new Set(corpora.filter((c) => c.pending > 0).map((c) => c.corpusProjectId))
    for (const id of paced.keys()) if (!withWork.has(id)) paced.delete(id)
    let rotation = rotationOf(corpora)
    const alone: string[] = []
    let stop: OcrSyncStop = OCR_SYNC_STOP.DONE
    let firstRound = true
    rounds: while (rotation.length > 0) {
      const next: typeof rotation = []
      for (const entry of rotation) {
        if (d.batches >= limits.maxBatches) {
          stop = OCR_SYNC_STOP.BUDGET
          break rounds
        }
        const pacing = paced.get(entry.corpusProjectId)
        if (pacing !== undefined && pacing.until > ports.now()) continue
        // The cursor moves with the FIRST round only: later rounds re-serve
        // corpora already reached, and the next sweep resumes after the
        // furthest one.
        if (firstRound && entry.resync) cursor.resync = entry.corpusProjectId
        if (firstRound && !entry.resync) cursor.rest = entry.corpusProjectId
        if ((await turn(entry.corpusProjectId, alone, d)) === "again") next.push(entry)
      }
      rotation = next
      firstRound = false
    }
    await isolate(alone, d)
    if (d.requests > 0 && !d.controlled) return OCR_SYNC_STOP.WORKER_UNAVAILABLE
    return stop
  }

  /** The once-per-drain error line of a deploy mismatch (B): both versions, a sample of ARKs. */
  function reportSkew(d: Drain): void {
    for (const [v, arks] of d.skew) {
      ports.error(
        `artifact version mismatch: ${arks.length} ARK(s) answered with worker artifact v${v}, this app reads v${OCR_QUALITY_ARTIFACT_VERSION} — deploy the matching app and worker; marked incompatible, asked again in 24 h`,
        arks.slice(0, 5).join(", "),
      )
    }
  }

  /**
   * Run one drain, or fold into the running one (which sweeps again). Resolves
   * with why it stopped; rejects only on an unexpected failure (a DB error),
   * already logged.
   */
  async function drain(lifecycle: AbortSignal): Promise<OcrSyncReport> {
    const tally: OcrSyncTally = {
      available: 0,
      building: 0,
      unavailable: 0,
      incompatible: 0,
      rejected: 0,
      outage: 0,
      struck: 0,
    }
    if (state.running) {
      state.rerun = true
      return { stop: OCR_SYNC_STOP.COALESCED, tally }
    }
    state.running = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limits.drainDeadlineMs)
    const d: Drain = {
      deadline: ports.now() + limits.drainDeadlineMs,
      signal: AbortSignal.any([controller.signal, lifecycle]),
      tally,
      batches: 0,
      isolation: limits.isolationBudget,
      controlled: false,
      failures: 0,
      requests: 0,
      skew: new Map(),
    }
    try {
      let stop: OcrSyncStop = OCR_SYNC_STOP.DONE
      do {
        state.rerun = false
        try {
          stop = await sweep(d)
        } catch (err) {
          if (err instanceof DrainStop) {
            stop = err.stop
            break
          }
          if (d.signal.aborted && (err instanceof DeadlineExceededError || isAbortError(err))) {
            stop = OCR_SYNC_STOP.DEADLINE
            break
          }
          throw err
        }
      } while (state.rerun && stop === OCR_SYNC_STOP.DONE && !d.signal.aborted)
      return { stop, tally }
    } finally {
      clearTimeout(timer)
      reportSkew(d)
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

/** The production limits — the ones the poison/outage tests run under too. */
export const OCR_SYNC_LIMITS: OcrSyncLimits = {
  drainDeadlineMs: OCR_SYNC_DRAIN_DEADLINE_MS,
  batchSize: OCR_SYNC_BATCH_SIZE,
  maxBatches: OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  isolationBudget: OCR_SYNC_ISOLATION_BUDGET,
  maxAttempts: OCR_SYNC_MAX_ATTEMPTS,
  controlPool: OCR_SYNC_CONTROL_POOL,
}

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
  controlArks: (exclude, limit, signal) =>
    boundedRead("control ARKs", DocumentQueries.ocrControlArks(exclude, limit), signal),
  syncBatch: (arks, signal) => DocumentService.syncOcrBatch(arks, signal),
  recordRejection: (ark, message, now, askedAt, signal) =>
    DocumentService.recordOcrRejection(ark, message, now, askedAt, signal),
  recordBatchOutage: (arks, askedAt, signal) => DocumentService.recordOcrBatchOutage(arks, askedAt, signal),
  recordAloneFailure: (ark, message, opts, signal) =>
    DocumentService.recordOcrAloneFailure(ark, message, opts, signal),
  batchCostMs: () => DocumentService.ocrSyncRequestTimeoutMs() + OCR_SYNC_BATCH_WRITE_MARGIN_MS,
  now: () => Date.now(),
  log: (message) => console.log(`[ocr-sync] ${message}`),
  warn: (message, err) => console.warn(`[ocr-sync] ${message}:`, err),
  error: (message, err) => console.error(`[ocr-sync] ${message}:`, err),
}

/**
 * The drainer's whole lifecycle — the drainer (and so its running guard,
 * pause, corpus pacing and rotation cursors), the abort controller and the stop handle — lives
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
    drain: createOcrSyncDrainer(realPorts, OCR_SYNC_LIMITS).drain,
    controller: new AbortController(),
    stop: null,
  }
  Reflect.set(globalThis, LIFECYCLE_KEY, created)
  return created
}

function syncEnabled(): boolean {
  return clusterMode() === CLUSTER_MODE.REAL
}

/**
 * At boot, before the first drain: `incompatible` rows recorded against
 * another artifact version than this app reads are due at once — this deploy
 * may be the one that fixes the skew (DocumentService.reopenIncompatibleOcr).
 */
async function reopenIncompatible(signal: AbortSignal): Promise<void> {
  const reopened = await withDeadline(DocumentService.reopenIncompatibleOcr(new Date()), {
    label: "[ocr-sync] reopen incompatible",
    ms: OCR_DB_TIMEOUT_MS,
    signal,
  })
  if (reopened > 0) {
    realPorts.log(`${reopened} incompatible row(s) recorded against another artifact version are due again`)
  }
}

async function runDrain(trigger: string): Promise<void> {
  const life = lifecycle()
  if (trigger === "boot") await reopenIncompatible(life.controller.signal)
  const report = await life.drain(life.controller.signal)
  if (report.stop === OCR_SYNC_STOP.COALESCED) return
  const { tally } = report
  const moved = Object.values(tally).reduce((sum, n) => sum + n, 0)
  if (moved === 0 && report.stop === OCR_SYNC_STOP.DONE) return
  realPorts.log(
    `cycle (${trigger}): available=${tally.available}, building=${tally.building}, unavailable=${tally.unavailable}, incompatible=${tally.incompatible}, rejected=${tally.rejected}, outage=${tally.outage}, struck=${tally.struck}, stop=${report.stop}`,
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
