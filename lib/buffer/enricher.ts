// lib/buffer/enricher.ts
// Background metadata enrichment for BARE buffer rows — the BufferItem table is
// the work queue (enrichStatus = pending), on the resolver's model
// (lib/documents/resolver.ts).
//
// Why: buffer_add stages ARKs with no metadata. On 0.18.1 they stayed bare
// forever (99 % of the 17 422 prod buffer_add rows had no title), so every
// filter the librarian asked for — "garde la presse métropolitaine" — had
// nothing to work on (feedback #10a).
//
// Order per batch (Decision 8 of the Track E plan):
//   1. Copy from a resolved Document of the same project — zero BnF cost.
//   2. The rest through BnfDirectClient.resolveArksForStaging: the broker-routed
//      OAI-PMH record for Gallica (carries the typedoc, the only press
//      discriminator), the catalogue SRU for `cb…`. Never the MCP (new app
//      egress belongs on the broker — playbook/mcp-client.md) and never the
//      manifest (its bucket is the ingestion bottleneck).
//   3. A failure increments enrichAttempts and sets a doubling backoff
//      (enrichNextAttemptAt); the row is failed at the ceiling, or at once when
//      the BnF does not know the ARK. A failure of a whole batch (the client
//      threw) is persisted on each of its rows the same way. The drain's OWN
//      ceiling is never an attempt: a row it cut off was not refused by
//      anyone, so it stays pending, uncounted, for the next pass.
//
// Classification: the same rules as a search hit (bufferMetadataFromDocument →
// bufferDocTypeFromRecord), so one ARK gets one docType and record kind
// whichever path wrote it; an unrecognised type label is logged.
//
// Execution: kicked via `after()` by buffer_add, resumed at boot and by a
// periodic sweep from instrumentation.ts. Never inline in a tool call. Bounds
// (§14): every BnF call carries the drain's signal, which aborts at
// BUFFER_ENRICH_DRAIN_MAX_MS; a pass takes at most
// BUFFER_ENRICH_BATCH_SIZE × BUFFER_ENRICH_DRAIN_MAX_BATCHES rows; rows are
// written with a guarded update, so a row cleared mid-drain is skipped, not
// fatal. Every database await is bounded by the pool's statement and
// connection timeouts (lib/db.ts), so the overlap guards below always clear.
// There is no in-loop sleep — a transient failure waits out its backoff and is
// retried by a later pass.
import "server-only"

import { after } from "next/server"

import {
  BUFFER_CLASSIFIER_VERSION,
  BUFFER_ENRICH_BATCH_SIZE,
  BUFFER_ENRICH_DRAIN_MAX_BATCHES,
  BUFFER_ENRICH_DRAIN_MAX_MS,
  BUFFER_ENRICH_MAX_ATTEMPTS,
  BUFFER_ENRICH_RETRY_BASE_MS,
} from "@/lib/constants"
import { BnfDirectClient } from "@/lib/bnf/direct"
import type { BnfMcpResolveError, BnfMcpResolveResult } from "@/lib/bnf/types"
import { BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { normalizeMany } from "@/lib/mcp/normalize"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BufferQueries } from "@/models/buffer/queries"
import { BUFFER_ENRICH_STATUS } from "@/models/buffer/schema"
import { DocumentQueries } from "@/models/documents/queries"
import { bufferMetadataFromDocument, type ResolvedDocumentFields } from "./classify"

/** The one method the drain needs — BnfDirectClient in production, a counting
 *  fake in tests. */
export interface BufferEnrichClient {
  resolveArksForStaging(arks: string[]): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>>
}

/** Builds the drain's client, bound to the drain's abort signal. */
export type BufferEnrichClientFactory = (signal: AbortSignal) => BufferEnrichClient

/** Test seams; production uses the real clock and the drain ceiling. */
export type BufferEnrichDeps = {
  client: BufferEnrichClientFactory
  now?: () => Date
  maxDrainMs?: number
}

function log(msg: string): void {
  console.log(`[buffer-enrich] ${msg}`)
}

function logUnknownDocType(label: string): void {
  console.warn(`[vocab] unknown dc:type "${label}" (buffer enrichment) → other`)
}

/** At most one drain per project at a time; a kick during a drain sets
 *  `rerun` so rows staged meanwhile are picked up, never dropped. */
const active = new Map<string, { rerun: boolean }>()

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How deep `causedByOwnCeiling` follows an error's `cause` chain. */
const MAX_CAUSE_DEPTH = 5

/**
 * True when `error` IS the drain's own abort — the signal's reason, or an
 * AbortError — directly or through its `cause` chain. Classified by CAUSE, not
 * by the signal's state: a 404 that happens to land after the ceiling fired is
 * still the BnF's answer, and counts.
 */
function causedByOwnCeiling(error: unknown, signal: AbortSignal): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    if (signal.aborted && current === signal.reason) return true
    if (current instanceof Error && current.name === "AbortError") return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/** The backoff after the `attempts`-th failure: base × 2^(attempts − 1). */
function retryAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + BUFFER_ENRICH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

/** The columns a resolved record fills, in the current classification. */
function resolvedData(doc: ResolvedDocumentFields): Prisma.BufferItemUpdateManyMutationInput {
  return {
    ...bufferMetadataFromDocument(doc, logUnknownDocType),
    classifierVersion: BUFFER_CLASSIFIER_VERSION,
    enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED,
    enrichError: null,
    enrichNextAttemptAt: null,
  }
}

/** The columns of a failed attempt: counted, explained, backed off — or failed for good. */
function failedAttemptData(
  attempts: number,
  reason: string,
  terminal: boolean,
  now: Date,
): Prisma.BufferItemUpdateManyMutationInput {
  return {
    enrichAttempts: attempts,
    enrichError: reason,
    ...(terminal
      ? { enrichStatus: BUFFER_ENRICH_STATUS.FAILED, enrichNextAttemptAt: null }
      : { enrichNextAttemptAt: retryAt(now, attempts) }),
  }
}

type DrainTally = {
  fromDocuments: number
  fromBnf: number
  failed: number
  retry: number
  skipped: number
  /** Cut off by the drain's own ceiling: left pending, no attempt counted. */
  deferred: number
}

/** Noted on a row the drain's own ceiling cut off — not an attempt. */
const DRAIN_CEILING_NOTE = "délai de la passe dépassé — reprise à la prochaine passe (non compté)"

/**
 * Enrich every ready candidate row of a project. Re-entrant-safe: concurrent
 * calls coalesce into one active drain that re-checks before exiting, within
 * one wall-clock ceiling for the whole drain. `deps` has no default client —
 * production passes the broker-routed BnfDirectClient.
 */
export async function enrichPendingForProject(projectId: string, deps: BufferEnrichDeps): Promise<void> {
  const existing = active.get(projectId)
  if (existing) {
    existing.rerun = true
    return
  }
  const state = { rerun: false }
  active.set(projectId, state)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), deps.maxDrainMs ?? BUFFER_ENRICH_DRAIN_MAX_MS)
  try {
    const client = deps.client(deadline.signal)
    do {
      state.rerun = false
      await drainOnce(projectId, client, deadline.signal, deps.now ?? (() => new Date()))
    } while (state.rerun && !deadline.signal.aborted)
    if (deadline.signal.aborted) log(`project ${projectId}: drain stopped at its time ceiling — the next sweep resumes`)
  } finally {
    clearTimeout(timer)
    active.delete(projectId)
  }
}

/** One bounded pass over the project's ready candidates. */
async function drainOnce(
  projectId: string,
  client: BufferEnrichClient,
  signal: AbortSignal,
  now: () => Date,
): Promise<void> {
  const pending = await BufferQueries.enrichBatch(
    projectId,
    now(),
    BUFFER_ENRICH_MAX_ATTEMPTS,
    BUFFER_ENRICH_BATCH_SIZE * BUFFER_ENRICH_DRAIN_MAX_BATCHES,
  )
  if (pending.length === 0) return

  log(`project ${projectId}: enriching ${pending.length} bare candidate(s)`)
  const attemptsByArk = new Map(pending.map((p) => [p.ark, p.enrichAttempts]))
  const tally: DrainTally = { fromDocuments: 0, fromBnf: 0, failed: 0, retry: 0, skipped: 0, deferred: 0 }

  const write = async (ark: string, data: Prisma.BufferItemUpdateManyMutationInput) => {
    if (!(await BufferQueries.writeEnrichment(projectId, ark, data))) tally.skipped += 1
  }
  const fail = async (ark: string, reason: string, notFound: boolean) => {
    const before = attemptsByArk.get(ark)
    if (before === undefined) {
      // The client answered for an ARK this pass never asked about: a client
      // bug, never a reason to reset that row's attempt count.
      throw new Error(`enrichment answered for an ARK it was not asked: ${ark}`)
    }
    const attempts = before + 1
    const terminal = notFound || attempts >= BUFFER_ENRICH_MAX_ATTEMPTS
    if (terminal) tally.failed += 1
    else tally.retry += 1
    await write(ark, failedAttemptData(attempts, reason, terminal, now()))
  }
  /** A row our own ceiling cut off: explained, never counted, not backed off. */
  const defer = async (ark: string) => {
    tally.deferred += 1
    await write(ark, { enrichError: DRAIN_CEILING_NOTE })
  }

  for (const batch of chunk(pending.map((p) => p.ark), BUFFER_ENRICH_BATCH_SIZE)) {
    if (signal.aborted) break

    // 1. Same-project resolved Documents: free.
    const docs = await DocumentQueries.resolvedAmong(new Map([[projectId, batch]]))
    const fromDoc = new Set(docs.map((d) => d.ark))
    for (const d of docs) await write(d.ark, resolvedData(d))
    tally.fromDocuments += docs.length

    // 2. The rest through the broker.
    const rest = batch.filter((ark) => !fromDoc.has(ark))
    if (rest.length === 0) continue
    let results: Array<BnfMcpResolveResult | BnfMcpResolveError>
    try {
      results = await client.resolveArksForStaging(rest)
    } catch (err) {
      if (causedByOwnCeiling(err, signal)) {
        // Our own ceiling, not a BnF failure: nothing refused these rows.
        for (const ark of rest) await defer(ark)
        break
      }
      // The whole batch failed (broker down): every row counts the attempt
      // and backs off — never an uncounted, endless retry.
      console.error(`[buffer-enrich] project ${projectId}: batch of ${rest.length} failed:`, err)
      for (const ark of rest) await fail(ark, describeError(err), false)
      continue
    }
    const normalised = normalizeMany(results.filter((r) => r.ok).map((r) => r.document))
    const byArk = new Map(normalised.map((n) => [n.ark, n]))

    for (const r of results) {
      const doc = byArk.get(r.ark)
      if (r.ok && doc) {
        await write(
          r.ark,
          resolvedData({
            ark: doc.ark,
            title: doc.title,
            author: doc.author ?? null,
            year: doc.year ?? null,
            dateLabel: doc.dateLabel ?? null,
            docType: doc.docType,
            lang: doc.lang ?? null,
            rawMetadata: doc.rawMetadata,
          }),
        )
        tally.fromBnf += 1
        continue
      }
      // A per-ARK failure caused by our own ceiling is not an attempt.
      if (!r.ok && causedByOwnCeiling(r.error, signal)) {
        await defer(r.ark)
        continue
      }
      // The call failed, or it succeeded with an unusable record (no title).
      const reason = r.ok ? "métadonnées incomplètes (titre manquant)" : describeError(r.error)
      await fail(r.ark, reason, !r.ok && r.error instanceof BnfMcpNotFoundError)
    }
  }

  log(
    `project ${projectId}: drain done — from-documents=${tally.fromDocuments}, from-bnf=${tally.fromBnf}, ` +
      `failed=${tally.failed}, still-pending=${tally.retry}, deferred-by-ceiling=${tally.deferred}, ` +
      `gone-meanwhile=${tally.skipped}`,
  )
}

/** The production client: the broker-routed BnF client, bound to the drain. */
const directClient: BufferEnrichClientFactory = (signal) => new BnfDirectClient({ signal })

/**
 * Schedule a drain after the current response is flushed. Called from the
 * buffer_add tool (inside the request scope); the drain outlives the request
 * and is bounded by its own ceiling.
 */
export function kickBufferEnrich(projectId: string): void {
  after(async () => {
    await enrichPendingForProject(projectId, { client: directClient }).catch((err: unknown) => {
      console.error(`[buffer-enrich] drain failed for project ${projectId}:`, err)
    })
  })
}

/** True while a sweep runs: the periodic timer never starts a second one. */
let sweeping = false

/**
 * Boot resume and periodic sweep: drain every project that has rows ready to
 * enrich. Fire-and-forget from instrumentation.ts — never blocks serving. A
 * call while a sweep is still running returns at once (overlap guard).
 */
export async function resumePendingBufferEnrich(): Promise<void> {
  if (sweeping) {
    log("sweep skipped — the previous one is still running")
    return
  }
  sweeping = true
  try {
    const projects = await BufferQueries.projectsReadyToEnrich(new Date(), BUFFER_ENRICH_MAX_ATTEMPTS)
    if (projects.length === 0) return
    log(`resume — ${projects.length} project(s) with pending candidates`)
    for (const projectId of projects) {
      await enrichPendingForProject(projectId, { client: directClient }).catch((err: unknown) => {
        console.error(`[buffer-enrich] resume drain failed for project ${projectId}:`, err)
      })
    }
  } finally {
    sweeping = false
  }
}
