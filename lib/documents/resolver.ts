// lib/documents/resolver.ts
// Background metadata resolver — the Document table IS the work queue.
//
// `corpus_add` inserts "stub" Document rows (resolveStatus="pending") and
// returns instantly; this drainer resolves their BnF metadata out-of-band so
// curation is never coupled to BnF availability/latency.
//
// Order per batch: the global BnF record cache first (models/bnf-records — a
// record any project already resolved, or the buffer enricher staged, costs no
// OAI call), then BnF for the misses only. A STAGED cache entry (OAI only, no
// OCR verdict yet) is handed to the client so it runs only the OCR rule on it,
// never the OAI fetch again. Fresh results are stored in the same transaction
// as the document writes; normalization runs on every read, so a rule change
// applies to cached records too.
//
// Failure handling (mirrors lib/buffer/enricher.ts):
//   - a transient failure counts an attempt and sets an exponential
//     `nextResolveAt` (RESOLVE_RETRY_BASE_MS, capped at RESOLVE_RETRY_CAP_MS);
//     the row fails at RESOLVE_MAX_ATTEMPTS;
//   - an ARK the BnF does not know is failed at once (retrying changes nothing);
//   - a 429 backs the row off by the BnF's Retry-After without counting an
//     attempt: the BnF did not refuse the document, it refused the rate;
//   - the drain's own wall-clock ceiling (RESOLVE_DRAIN_MAX_MS, one controller
//     for the whole drain including reruns) is never an attempt: a row it cut
//     off stays pending, untouched, for the next pass.
//
// Execution: kicked via `after()` at add time and resumed at boot and by a
// periodic sweep from instrumentation.ts. There is no separate job table and no
// external worker — the cluster runner does ingestion, not metadata resolution.
import "server-only"

import { after } from "next/server"

import { DeadlineExceededError, withDeadline } from "@/lib/async/deadline"
import { processSingleton } from "@/lib/async/process-singleton"
import {
  DRAINER_DB_TIMEOUT_MS,
  RESOLVE_BATCH_SIZE,
  RESOLVE_DRAIN_MAX_BATCHES,
  RESOLVE_DRAIN_MAX_MS,
  RESOLVE_MAX_ATTEMPTS,
  RESOLVE_RETRY_BASE_MS,
  RESOLVE_RETRY_CAP_MS,
} from "@/lib/constants"
import { causedByOwnCeiling } from "@/lib/async/abort"
import { BnfDirectClient } from "@/lib/bnf/direct"
import {
  RESOLVE_MODE,
  type BnfMcpDocumentDetail,
  type BnfMcpResolveError,
  type BnfMcpResolveResult,
} from "@/lib/bnf/types"
import { BnfMcpError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import { normalizeMany } from "@/lib/mcp/normalize"
import { BnfRecordService } from "@/models/bnf-records/service"
import type { Prisma } from "@/lib/generated/prisma/client"
import { DocumentQueries } from "@/models/documents/queries"
import { DOCUMENT_RESOLVE_STATUS, type ResolveRowWrite } from "@/models/documents/schema"
import { DocumentService, resolvedRowData } from "@/models/documents/service"

/** Structured log line for the resolver. Prefix lets ops grep `[resolver]`. */
function log(msg: string): void {
  console.log(`[resolver] ${msg}`)
}

// ---------------------------------------------------------------------------
// Re-entrancy guards
// ---------------------------------------------------------------------------
// At most one drain runs per project at a time. A drain requested while one is
// active sets `rerun` so the active loop picks up rows added in the meantime,
// rather than being silently dropped. At most one sweep runs at a time. Both
// guards live on globalThis under a registered symbol: Next.js may evaluate this
// module more than once, and a second copy must share the guards, never hold
// its own beside them.
type ResolverGuards = {
  active: Map<string, { rerun: boolean }>
  sweeping: boolean
}

const GUARDS_KEY = Symbol.for("bnf.documents.resolver-guards")

function isGuards(v: unknown): v is ResolverGuards {
  return (
    typeof v === "object" &&
    v !== null &&
    "active" in v &&
    v.active instanceof Map &&
    "sweeping" in v &&
    typeof v.sweeping === "boolean"
  )
}

function guards(): ResolverGuards {
  return processSingleton<ResolverGuards>(GUARDS_KEY, () => ({ active: new Map(), sweeping: false }), isGuards)
}

/** A database or cache await of the drain, bounded by the pool deadline and, for a read, the drain's own signal. */
function bounded<T>(label: string, work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return withDeadline(work, { label: `[resolver] ${label}`, ms: DRAINER_DB_TIMEOUT_MS, signal })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** How a drain asks the client: `staged` holds the cached OAI-only records whose OCR rule is still to run. */
export type CommitResolveOptions = {
  mode: typeof RESOLVE_MODE.COMMIT
  staged?: ReadonlyMap<string, BnfMcpDocumentDetail>
}

/** The one method the drain needs — BnfDirectClient in production, a fake in tests. */
export interface DocumentResolveClient {
  resolveArks(
    arks: string[],
    opts: CommitResolveOptions,
  ): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>>
}

/** Builds the drain's client, bound to the drain's abort signal. */
export type DocumentResolveClientFactory = (signal: AbortSignal) => DocumentResolveClient

/** Test seams; production uses the broker-routed client, the real clock and the drain ceiling. */
export type ResolveOptions = {
  signal?: AbortSignal
  client?: DocumentResolveClientFactory
  now?: () => Date
  maxDrainMs?: number
}

const directClient: DocumentResolveClientFactory = (signal) => new BnfDirectClient({ signal })

/** Noted on a row the drain's own ceiling cut off — not an attempt. */
const DRAIN_CEILING_NOTE = "délai de la passe dépassé — reprise à la prochaine passe (non compté)"

const INCOMPLETE_METADATA_REASON = "métadonnées incomplètes (titre ou identifiant manquant)"

/** The backoff after the `attempts`-th failure: base × 2^(attempts − 1), capped. */
function retryAt(now: Date, attempts: number): Date {
  const delay = Math.min(RESOLVE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RESOLVE_RETRY_CAP_MS)
  return new Date(now.getTime() + delay)
}

/** When a rate-limited row may try again: the BnF's Retry-After if it gave a usable one, else the base backoff; never past the cap. */
function rateLimitRetryAt(now: Date, retryAfterMs: number | undefined): Date {
  const usable = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
  return new Date(now.getTime() + Math.min(usable ? retryAfterMs : RESOLVE_RETRY_BASE_MS, RESOLVE_RETRY_CAP_MS))
}

const FAILURE_KIND = {
  DEFERRED: "deferred",
  RATE_LIMITED: "rate_limited",
  RETRY: "retry",
  FAILED: "failed",
} as const
type FailureKind = (typeof FAILURE_KIND)[keyof typeof FAILURE_KIND]

type Failure = {
  kind: FailureKind
  reason: string
  attempts: number
  data: Prisma.DocumentUpdateManyMutationInput
}

/**
 * What a failed resolve does to its row. Classified by the error's cause:
 *   - the drain's own ceiling: nothing refused the row — not an attempt;
 *   - not found: terminal at once;
 *   - rate limited: backed off by Retry-After, not an attempt;
 *   - anything else is transient: an attempt, a backoff, terminal at the ceiling.
 */
function classifyFailure(error: unknown, attemptsBefore: number, now: Date, signal: AbortSignal): Failure {
  if (causedByOwnCeiling(error, signal)) {
    return { kind: FAILURE_KIND.DEFERRED, reason: DRAIN_CEILING_NOTE, attempts: attemptsBefore, data: { resolveError: DRAIN_CEILING_NOTE } }
  }
  const reason = describeError(error)
  if (error instanceof BnfMcpRateLimitError) {
    return {
      kind: FAILURE_KIND.RATE_LIMITED,
      reason,
      attempts: attemptsBefore,
      data: { resolveError: reason, nextResolveAt: rateLimitRetryAt(now, error.retryAfterMs) },
    }
  }
  const attempts = attemptsBefore + 1
  if (error instanceof BnfMcpNotFoundError || attempts >= RESOLVE_MAX_ATTEMPTS) {
    return {
      kind: FAILURE_KIND.FAILED,
      reason,
      attempts,
      data: { resolveAttempts: attempts, resolveError: reason, resolveStatus: DOCUMENT_RESOLVE_STATUS.FAILED, nextResolveAt: null },
    }
  }
  return {
    kind: FAILURE_KIND.RETRY,
    reason,
    attempts,
    data: { resolveAttempts: attempts, resolveError: reason, nextResolveAt: retryAt(now, attempts) },
  }
}

/**
 * Resolve all currently-pending Document rows for a project. Re-entrant-safe:
 * concurrent calls coalesce into a single active drain that re-checks for new
 * pending rows before exiting, within one wall-clock ceiling for the whole
 * drain (all its batches and reruns).
 */
export async function resolvePendingForProject(projectId: string, opts?: ResolveOptions): Promise<void> {
  const { active } = guards()
  const existing = active.get(projectId)
  if (existing) {
    existing.rerun = true
    return
  }
  const state = { rerun: false }
  active.set(projectId, state)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), opts?.maxDrainMs ?? RESOLVE_DRAIN_MAX_MS)
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal
  try {
    const client = (opts?.client ?? directClient)(signal)
    try {
      do {
        state.rerun = false
        await drainOnce(projectId, client, signal, opts?.now ?? (() => new Date()))
      } while (state.rerun && !signal.aborted)
    } catch (err) {
      // The ceiling (or the caller's abort) cut a database await: the drain
      // stopped, nothing failed. Any other error is a real failure.
      if (!(err instanceof DeadlineExceededError && signal.aborted)) throw err
    }
    if (deadline.signal.aborted) log(`project ${projectId}: drain stopped at its time ceiling — the next sweep resumes`)
    else if (signal.aborted) log(`project ${projectId}: aborted mid-drain`)
  } finally {
    clearTimeout(timer)
    active.delete(projectId)
  }
}

/**
 * One drain pass: snapshot the due pending ARKs (bounded), resolve them in
 * batches (cache first, BnF for the misses), and write each row to
 * resolved/failed/backed-off. Each ARK is attempted at most once per pass.
 */
async function drainOnce(
  projectId: string,
  client: DocumentResolveClient,
  signal: AbortSignal,
  now: () => Date,
): Promise<void> {
  const pending = await bounded(
    "due pending rows",
    DocumentQueries.dueResolveRows(projectId, now(), RESOLVE_BATCH_SIZE * RESOLVE_DRAIN_MAX_BATCHES),
    signal,
  )
  if (pending.length === 0) return

  log(`project ${projectId}: draining ${pending.length} pending document(s)`)
  const attemptsByArk = new Map(pending.map((p) => [p.ark, p.resolveAttempts]))
  const tally = { resolved: 0, fromCache: 0, failed: 0, retry: 0, rateLimited: 0, deferred: 0 }

  for (const batch of chunk(pending.map((p) => p.ark), RESOLVE_BATCH_SIZE)) {
    if (signal.aborted) break

    // 1. The global record cache: a COMPLETE entry is final; a STAGED one goes
    //    to the client with the rest, which runs only its OCR rule.
    const cached = await bounded("record cache read", BnfRecordService.foundAmong(batch), signal)
    const fromCache: BnfMcpResolveResult[] = []
    const toFetch: string[] = []
    const staged = new Map<string, BnfMcpDocumentDetail>()
    for (const ark of batch) {
      const hit = cached.get(ark)
      if (hit && !BnfRecordService.needsOcrRule(ark, hit)) {
        fromCache.push({ ark, ok: true, document: hit })
        continue
      }
      toFetch.push(ark)
      if (hit) staged.set(ark, hit)
    }

    // 2. The BnF, for what the cache could not finish.
    let fetched: Array<BnfMcpResolveResult | BnfMcpResolveError> = []
    if (toFetch.length > 0) {
      try {
        fetched = await client.resolveArks(toFetch, staged.size > 0 ? { mode: RESOLVE_MODE.COMMIT, staged } : { mode: RESOLVE_MODE.COMMIT })
      } catch (err) {
        // The whole call failed (broker down, or our own ceiling): every row
        // of it is classified by that one error, never retried unaccounted.
        if (!causedByOwnCeiling(err, signal)) {
          console.error(`[resolver] project ${projectId}: batch of ${toFetch.length} failed:`, err)
        }
        fetched = toFetch.map((ark) => ({ ark, ok: false as const, error: err }))
      }
    }

    const results = [...fromCache, ...fetched]
    const normalisedByArk = new Map(
      normalizeMany(results.filter((r) => r.ok).map((r) => r.document), {
        onRejected: (ark, reason) =>
          console.warn(`[resolver] project ${projectId}: record refused by normalize`, { ark, reason }),
      }).map((n) => [n.ark, n]),
    )
    const freshArks = new Set(fetched.map((r) => r.ark))
    const fresh: BnfMcpResolveResult[] = []

    // One transaction per batch (DocumentService.recordResolveBatch): the rows,
    // the cache entries of what the BnF just answered and the prompt invalidation.
    const rows: ResolveRowWrite[] = []
    for (const r of results) {
      const attemptsBefore = attemptsByArk.get(r.ark)
      if (attemptsBefore === undefined) {
        // The client answered for an ARK this pass never asked about: a client
        // bug, never a reason to reset that row's attempt count.
        throw new Error(`resolve answered for an ARK it was not asked: ${r.ark}`)
      }
      const doc = r.ok ? normalisedByArk.get(r.ark) : undefined
      if (r.ok && doc) {
        tally.resolved++
        if (freshArks.has(r.ark)) fresh.push(r)
        else tally.fromCache++
        rows.push({ ark: r.ark, data: resolvedRowData(doc, now()) })
        continue
      }
      // Either the resolve call failed, or it succeeded but normalize dropped
      // the record (no title / unusable). The latter is an ordinary transient
      // failure and is not cached: a retry must be able to see a better record.
      const error = r.ok ? new BnfMcpError(INCOMPLETE_METADATA_REASON) : r.error
      const failure = classifyFailure(error, attemptsBefore, now(), signal)
      if (failure.kind === FAILURE_KIND.FAILED) tally.failed++
      else if (failure.kind === FAILURE_KIND.RETRY) tally.retry++
      else if (failure.kind === FAILURE_KIND.RATE_LIMITED) tally.rateLimited++
      else tally.deferred++
      if (failure.kind !== FAILURE_KIND.DEFERRED) {
        log(`  ${failure.kind} ${r.ark} (attempt ${failure.attempts}/${RESOLVE_MAX_ATTEMPTS}): ${failure.reason}`)
      }
      rows.push({ ark: r.ark, data: failure.data })
    }
    // Not tied to the drain's signal: when the ceiling cut the BnF call, this
    // write still records what the batch learned (cache hits, deferral notes).
    await bounded("batch write", DocumentService.recordResolveBatch(projectId, rows, fresh))
  }

  log(
    `project ${projectId}: drain done — resolved=${tally.resolved} (from-cache=${tally.fromCache}), ` +
      `failed=${tally.failed}, retry=${tally.retry}, rate-limited=${tally.rateLimited}, ` +
      `deferred-by-ceiling=${tally.deferred}`,
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Schedule a drain to run after the current response is flushed. Must be called
 * from within a request scope (agent tool handler / route). The request signal
 * is deliberately NOT threaded in — the drain outlives the request and is bounded
 * by its own ceiling, RESOLVE_DRAIN_MAX_MS.
 */
export function kickResolve(projectId: string): void {
  after(async () => {
    await resolvePendingForProject(projectId).catch((err: unknown) => {
      console.error(`[resolver] drain failed for project ${projectId}:`, err)
    })
  })
}

/**
 * Boot resume and periodic sweep: drain every project that still has due
 * pending stubs (e.g. left over from a process restart mid-resolution, or past
 * their backoff). Fire-and-forget from instrumentation.ts — never blocks
 * startup. A call while a sweep is still running returns at once (overlap guard).
 */
export async function resumePendingResolves(opts?: Pick<ResolveOptions, "client">): Promise<void> {
  const g = guards()
  if (g.sweeping) {
    log("sweep skipped — the previous one is still running")
    return
  }
  g.sweeping = true
  try {
    const projects = await withDeadline(DocumentQueries.projectsWithDueResolves(new Date()), {
      label: "[resolver] projects with due rows",
      ms: DRAINER_DB_TIMEOUT_MS,
    })
    if (projects.length === 0) return

    console.warn(
      `[resolver] resume — draining ${projects.length} project(s) with pending documents`,
    )
    for (const projectId of projects) {
      await resolvePendingForProject(projectId, opts).catch((err: unknown) => {
        console.error(`[resolver] resume drain failed for project ${projectId}:`, err)
      })
    }
  } finally {
    g.sweeping = false
  }
}
