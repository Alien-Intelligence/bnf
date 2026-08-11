import "server-only"
// lib/ingest/watchdog.ts
// Reconciler for ingest jobs the app-side lifecycle has otherwise lost track
// of (audit finding F18): a RUNNING job whose worker stopped reporting, or a
// QUEUED job that never made it to the worker at all. Without this, nothing
// app-side ever notices — the dedup guard in IngestService.submit() returns
// the stuck job on every later submit for that version, wedging the
// project's ingestion forever (prod job d8c69dbd, 2026-08-11).
//
// The QUEUED case is the F19 submit-failure corpse: IngestService.submit()
// now wraps ClusterRunner.submit in a try/catch and marks FAILED on any
// throw, so a NEW corpse of this shape should no longer be created — but a
// row written before that fix (or a future bug in the same shape) still
// needs a way out. QUEUED-older-than-15min is that way out.
//
// Split in two on purpose:
//   - decideWatchdogAction(): PURE. Given a job + the worker's current
//     read-model (or null) + now + the per-job "how long has the read-model
//     been null" state, returns exactly what to do. No I/O — fully
//     unit-testable with a fake clock, no database, no worker.
//   - startIngestWatchdog(): a thin interval shell that loads candidates,
//     polls the worker, and applies the decision. All I/O; no rules.
//
// INTERACTION WITH THE TERMINAL CALLBACK (belt 1, hardened in Slice 3): if
// this watchdog marks a job FAILED and the worker's real terminal callback
// then arrives late (the run actually finished right after we gave up),
// IngestService.applyProgress still applies it unconditionally —
// commit()/commitPartialFailure() overwrite status to DONE/PARTIAL without
// checking the job's current status. That is DESIRED: late truth wins. This
// watchdog's only job is to stop a stuck row from blocking the dedup guard
// forever, never to have the final say on outcome. See the comment on
// IngestService.applyProgress.
import { prisma } from "@/lib/db"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { IngestQueries } from "@/models/ingest/queries"
import { ClusterRunner } from "@/lib/cluster/runner"
import type { ClusterQueueProgress } from "@/lib/cluster/contracts"

/** How stale a QUEUED job (no clusterJobId) must be to count as an F19 corpse. */
export const WATCHDOG_QUEUED_STALE_MS = 15 * 60 * 1000
/** How long the worker's read-model may 404 / be unreachable before a RUNNING job is given up on. */
export const WATCHDOG_RUNNING_STALE_MS = 30 * 60 * 1000
/** Tick cadence for the interval loop. */
export const WATCHDOG_TICK_MS = 60 * 1000

/** The minimal job shape the pure decision function needs. */
export interface WatchdogJobInput {
  id: string
  status: string
  clusterJobId: string | null
  createdAt: Date
}

export type WatchdogAction =
  | { kind: "none" }
  | { kind: "write_progress"; progress: number; stats: Record<string, unknown> }
  | { kind: "fail"; reason: string }

export interface WatchdogDecision {
  action: WatchdogAction
  /**
   * Updated "the worker's read-model has been null since" timestamp for this
   * job — the caller persists this across ticks (a per-jobId Map). `null`
   * means "clear the entry": either progress just arrived, or there is
   * nothing to track for this job.
   */
  nullSince: Date | null
}

/**
 * Pure rule set — no I/O, fully deterministic given its inputs. See the
 * module doc for why this is split out.
 *
 * @param job - the candidate job. Expected to already be either RUNNING or
 *   QUEUED (the caller's query is the coarse filter); the rules below
 *   re-derive everything else from the inputs so they are provable standalone.
 * @param clusterProgress - the worker's live read-model for this job, or
 *   null (no clusterJobId to poll yet, or the poll 404'd / was unreachable).
 * @param now - injected clock.
 * @param nullSince - when `clusterProgress` started being continuously null
 *   for this job, as tracked by the caller across previous ticks; null if it
 *   has never been null (or was last seen non-null).
 */
export function decideWatchdogAction(
  job: WatchdogJobInput,
  clusterProgress: ClusterQueueProgress | null,
  now: Date,
  nullSince: Date | null,
): WatchdogDecision {
  if (job.status === INGEST_STATUS.QUEUED) {
    // A QUEUED job that already has a clusterJobId is not this rule's
    // business (it's mid-transition to RUNNING, or a modeling bug elsewhere)
    // — leave it alone rather than guess.
    if (job.clusterJobId) return { action: { kind: "none" }, nullSince: null }
    const age = now.getTime() - job.createdAt.getTime()
    if (age > WATCHDOG_QUEUED_STALE_MS) {
      return {
        action: { kind: "fail", reason: "soumission au worker jamais aboutie (watchdog)" },
        nullSince: null,
      }
    }
    return { action: { kind: "none" }, nullSince: null }
  }

  // RUNNING. No clusterJobId means the job is still inside the tiny window
  // between the job-row insert and ClusterRunner.submit returning — nothing
  // to poll yet, nothing to decide.
  if (!job.clusterJobId) return { action: { kind: "none" }, nullSince }

  if (clusterProgress !== null) {
    // F21: write-through a compact summary so the DB row stops lying while
    // v2 (which sends only the terminal callback) is running. `stage` is left
    // as-is (v2 has no per-stage breakdown to offer); `progress` is the docs
    // terminal fraction; `stats` is the per-status doc counts.
    const fraction =
      clusterProgress.docsTotal > 0
        ? clusterProgress.docsFinished / clusterProgress.docsTotal
        : 0
    return {
      action: { kind: "write_progress", progress: fraction, stats: clusterProgress.docs },
      nullSince: null, // progress arrived — the staleness clock resets
    }
  }

  // clusterProgress === null: the worker 404'd or was unreachable this tick.
  // Track how long that has been continuously true.
  const since = nullSince ?? now
  const staleMs = now.getTime() - since.getTime()
  if (staleMs > WATCHDOG_RUNNING_STALE_MS) {
    // The job is about to become terminal — nothing left to track.
    return {
      action: {
        kind: "fail",
        reason: "worker injoignable / run inconnu depuis 30 min (watchdog)",
      },
      nullSince: null,
    }
  }
  return { action: { kind: "none" }, nullSince: since }
}

// ---------------------------------------------------------------------------
// The interval shell — all I/O, no rules.
// ---------------------------------------------------------------------------

/**
 * Per-jobId "clusterProgress has been null since" state, kept in-memory for
 * the life of this process. A process restart just restarts the 30-minute
 * clock for any job that was mid-staleness when it happened — acceptable: the
 * job is still RUNNING in the DB and gets re-evaluated from a clean slate,
 * it just takes up to another 30 minutes to fail if the worker is still gone.
 */
const nullSinceByJob = new Map<string, Date>()

/**
 * Start the periodic reconciler. Returns a `stop()` for tests / graceful
 * shutdown; nothing currently calls it in prod (the process exits whole).
 *
 * No-op under any CLUSTER_MODE other than "real" — fake mode has no worker to
 * poll and IngestService.submit's fake path never leaves a transport-failure
 * corpse, so there is nothing for this watchdog to reconcile.
 */
export function startIngestWatchdog(): { stop: () => void } {
  if (process.env.CLUSTER_MODE !== "real") {
    return { stop: () => {} }
  }
  const timer = setInterval(() => {
    void runWatchdogTick().catch((err) => {
      console.error("[ingest-watchdog] tick failed:", err)
    })
  }, WATCHDOG_TICK_MS)
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}

async function runWatchdogTick(): Promise<void> {
  const now = new Date()
  const queuedCutoff = new Date(now.getTime() - WATCHDOG_QUEUED_STALE_MS)
  const candidates = await IngestQueries.watchdogCandidates(queuedCutoff)

  for (const job of candidates) {
    await applyToJob(job, now)
  }
}

async function applyToJob(job: WatchdogJobInput, now: Date): Promise<void> {
  const clusterProgress =
    job.status === INGEST_STATUS.RUNNING && job.clusterJobId
      ? await ClusterRunner.progress(job.clusterJobId)
      : null

  const nullSince = nullSinceByJob.get(job.id) ?? null
  const { action, nullSince: nextNullSince } = decideWatchdogAction(
    job,
    clusterProgress,
    now,
    nullSince,
  )

  if (nextNullSince) nullSinceByJob.set(job.id, nextNullSince)
  else nullSinceByJob.delete(job.id)

  switch (action.kind) {
    case "none":
      return
    case "write_progress":
      // Best-effort mirror of the read-model (F21) — guarded by `status:
      // RUNNING` so a job that went terminal between the candidate scan and
      // this write is left alone, and never throws (a failed write here must
      // not fail the tick or the job; it's presentation, not the commit path).
      await prisma.ingestJob
        .updateMany({
          where: { id: job.id, status: INGEST_STATUS.RUNNING },
          data: { progress: action.progress, stats: action.stats as never },
        })
        .catch((err) => {
          console.error("[ingest-watchdog] progress write-through failed:", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      return
    case "fail":
      // Guarded by `status: job.status` so a job that already went terminal
      // (e.g. a genuine terminal callback landed between the candidate scan
      // and this write) is never clobbered back to FAILED.
      await prisma.ingestJob
        .updateMany({
          where: { id: job.id, status: job.status },
          data: { status: INGEST_STATUS.FAILED, error: action.reason, finishedAt: now },
        })
        .catch((err) => {
          console.error("[ingest-watchdog] terminal fail write failed:", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      return
  }
}
