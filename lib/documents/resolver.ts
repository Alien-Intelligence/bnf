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

import {
  RESOLVE_BATCH_SIZE,
  RESOLVE_DRAIN_MAX_BATCHES,
  RESOLVE_DRAIN_MAX_MS,
  RESOLVE_MAX_ATTEMPTS,
  RESOLVE_RETRY_BASE_MS,
  RESOLVE_RETRY_CAP_MS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { BnfDirectClient } from "@/lib/bnf/direct"
import type { BnfMcpDocumentDetail, BnfMcpResolveError, BnfMcpResolveResult } from "@/lib/bnf/types"
import { causedByOwnCeiling } from "@/lib/buffer/enricher"
import { BnfMcpError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import { normalizeMany } from "@/lib/mcp/normalize"
import { BnfRecordService } from "@/models/bnf-records/service"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import type { Prisma } from "@/lib/generated/prisma/client"
import { SessionQueries } from "@/models/sessions/queries"
import { SESSION_SCOPE } from "@/models/sessions/schema"

/** Structured log line for the resolver. Prefix lets ops grep `[resolver]`. */
function log(msg: string): void {
  console.log(`[resolver] ${msg}`)
}

// ---------------------------------------------------------------------------
// Per-project re-entrancy guard
// ---------------------------------------------------------------------------
// At most one drain runs per project at a time. A drain requested while one is
// active sets `rerun` so the active loop picks up rows added in the meantime,
// rather than being silently dropped.
const active = new Map<string, { rerun: boolean }>()

type PrismaJsonValue =
  Parameters<typeof prisma.document.create>[0]["data"]["rawMetadata"]

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** How a drain asks the client: `staged` holds the cached OAI-only records whose OCR rule is still to run. */
export type CommitResolveOptions = {
  mode: "commit"
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

/** The pending rows a drain may try now: under the attempt ceiling and past their backoff. */
function dueNow(now: Date): Prisma.DocumentWhereInput {
  return {
    resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
    resolveAttempts: { lt: RESOLVE_MAX_ATTEMPTS },
    OR: [{ nextResolveAt: null }, { nextResolveAt: { lte: now } }],
  }
}

type FailureKind = "deferred" | "rate_limited" | "retry" | "failed"

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
    return { kind: "deferred", reason: DRAIN_CEILING_NOTE, attempts: attemptsBefore, data: { resolveError: DRAIN_CEILING_NOTE } }
  }
  const reason = describeError(error)
  if (error instanceof BnfMcpRateLimitError) {
    return {
      kind: "rate_limited",
      reason,
      attempts: attemptsBefore,
      data: { resolveError: reason, nextResolveAt: rateLimitRetryAt(now, error.retryAfterMs) },
    }
  }
  const attempts = attemptsBefore + 1
  if (error instanceof BnfMcpNotFoundError || attempts >= RESOLVE_MAX_ATTEMPTS) {
    return {
      kind: "failed",
      reason,
      attempts,
      data: { resolveAttempts: attempts, resolveError: reason, resolveStatus: DOCUMENT_RESOLVE_STATUS.FAILED, nextResolveAt: null },
    }
  }
  return {
    kind: "retry",
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
    do {
      state.rerun = false
      await drainOnce(projectId, client, signal, opts?.now ?? (() => new Date()))
    } while (state.rerun && !signal.aborted)
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
  const pending = await prisma.document.findMany({
    where: { projectId, ...dueNow(now()) },
    select: { ark: true, resolveAttempts: true },
    orderBy: { resolveAttempts: "asc" }, // give freshest stubs priority
    take: RESOLVE_BATCH_SIZE * RESOLVE_DRAIN_MAX_BATCHES,
  })
  if (pending.length === 0) return

  log(`project ${projectId}: draining ${pending.length} pending document(s)`)
  const attemptsByArk = new Map(pending.map((p) => [p.ark, p.resolveAttempts]))
  const tally = { resolved: 0, fromCache: 0, failed: 0, retry: 0, rateLimited: 0, deferred: 0 }

  for (const batch of chunk(pending.map((p) => p.ark), RESOLVE_BATCH_SIZE)) {
    if (signal.aborted) break

    // 1. The global record cache: a COMPLETE entry is final; a STAGED one goes
    //    to the client with the rest, which runs only its OCR rule.
    const cached = await BnfRecordService.foundAmong(batch)
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
        fetched = await client.resolveArks(toFetch, staged.size > 0 ? { mode: "commit", staged } : { mode: "commit" })
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
      normalizeMany(results.filter((r) => r.ok).map((r) => r.document)).map((n) => [n.ark, n]),
    )
    const freshArks = new Set(fetched.map((r) => r.ark))
    const fresh: BnfMcpResolveResult[] = []

    // One transaction per batch: the rows, the cache entries of what the BnF
    // just answered AND, when any document resolved, the invalidation of the
    // corpus prompts — they embed the head's type / lang / period counts, which
    // a resolved stub changes (a stub has none).
    const writes: Prisma.PrismaPromise<unknown>[] = []
    let batchResolved = 0
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
        batchResolved++
        if (freshArks.has(r.ark)) fresh.push(r)
        else tally.fromCache++
        writes.push(prisma.document.updateMany({
          where: { projectId, ark: r.ark },
          data: {
            title: doc.title,
            author: doc.author ?? null,
            year: doc.year ?? null,
            dateLabel: doc.dateLabel ?? null,
            docType: doc.docType,
            subtype: doc.subtype ?? null,
            lang: doc.lang ?? null,
            source: doc.source,
            pages: doc.pages ?? null,
            excerpt: doc.excerpt ?? null,
            iiifManifestUrl: doc.iiifManifestUrl ?? null,
            ocrAvailable: doc.ocrAvailable ?? null,
            rawMetadata: doc.rawMetadata as PrismaJsonValue,
            resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
            resolveError: null,
            nextResolveAt: null,
            resolvedAt: now(),
          },
        }))
        continue
      }
      // Either the resolve call failed, or it succeeded but normalize dropped
      // the record (no title / unusable). The latter is an ordinary transient
      // failure and is not cached: a retry must be able to see a better record.
      const error = r.ok ? new BnfMcpError(INCOMPLETE_METADATA_REASON) : r.error
      const failure = classifyFailure(error, attemptsBefore, now(), signal)
      if (failure.kind === "failed") tally.failed++
      else if (failure.kind === "retry") tally.retry++
      else if (failure.kind === "rate_limited") tally.rateLimited++
      else tally.deferred++
      if (failure.kind !== "deferred") {
        log(`  ${failure.kind} ${r.ark} (attempt ${failure.attempts}/${RESOLVE_MAX_ATTEMPTS}): ${failure.reason}`)
      }
      writes.push(prisma.document.updateMany({ where: { projectId, ark: r.ark }, data: failure.data }))
    }
    writes.push(...BnfRecordService.upsertStatements(fresh))
    if (batchResolved > 0) {
      // A statement of the batch $transaction below: built on the app client.
      writes.push(
        SessionQueries.invalidatePrompts({ projectId, scope: SESSION_SCOPE.CORPUS, withDerived: true }, prisma),
      )
    }
    await prisma.$transaction(writes)
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

/** True while a sweep runs: the periodic timer never starts a second one. */
let sweeping = false

/**
 * Boot resume and periodic sweep: drain every project that still has due
 * pending stubs (e.g. left over from a process restart mid-resolution, or past
 * their backoff). Fire-and-forget from instrumentation.ts — never blocks
 * startup. A call while a sweep is still running returns at once (overlap guard).
 */
export async function resumePendingResolves(opts?: Pick<ResolveOptions, "client">): Promise<void> {
  if (sweeping) {
    log("sweep skipped — the previous one is still running")
    return
  }
  sweeping = true
  try {
    const projects = await prisma.document.findMany({
      where: dueNow(new Date()),
      distinct: ["projectId"],
      select: { projectId: true },
    })
    if (projects.length === 0) return

    console.warn(
      `[resolver] resume — draining ${projects.length} project(s) with pending documents`,
    )
    for (const { projectId } of projects) {
      await resolvePendingForProject(projectId, opts).catch((err: unknown) => {
        console.error(`[resolver] resume drain failed for project ${projectId}:`, err)
      })
    }
  } finally {
    sweeping = false
  }
}
