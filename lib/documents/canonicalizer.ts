// lib/documents/canonicalizer.ts
// Background cb→Gallica canonicalizer — the Document.canonicalStatus column IS
// the work queue (sibling of the metadata resolver in lib/documents/resolver.ts).
//
// `corpus_add` adds a catalogue notice (`cb…`) to the corpus AS-IS — instantly,
// no network — and marks it canonicalStatus="pending". This drainer then runs
// out-of-band: it classifies each pending notice against its digitized Gallica
// reproduction and, for the ones the BnF has digitized, swaps the corpus
// membership (drop the notice, add the `bpt6k…`/`btv1b…` doc) in ONE new
// version — exactly what CorpusService.promoteNotice() does for a single ARK,
// batched. Notices with no digitization are recorded "not_digitized"; transient
// BnF failures become "api_error" (terminal for this auto-loop — the detail
// panel's manual "promote" affordance covers the retry, just as before).
//
// Why a new version rather than mutating the add's version: corpus versions are
// immutable once sealed (corpus-versioning.md). The membership key changes, so
// it must be a fresh advance under the per-project advisory lock.
//
// Execution mirrors the resolver: kicked via `after()` at add time, resumed at
// boot and on a periodic sweep from instrumentation.ts. No job table, no
// external worker — canonicalization is app-side (it talks to BnF directly).
import "server-only"

import { after } from "next/server"

import { DeadlineExceededError, withDeadline } from "@/lib/async/deadline"
import { processSingleton } from "@/lib/async/process-singleton"
import {
  BNF_CANONICALIZE_BUDGET_MS,
  CANONICALIZE_BATCH_SIZE,
  CANONICALIZE_DRAIN_MAX,
  CANONICALIZE_SWAP_TIMEOUT_MS,
  DRAINER_DB_TIMEOUT_MS,
} from "@/lib/constants"
import { BnfDirectClient } from "@/lib/bnf/direct"
import { CANONICAL_OUTCOME_STATUS } from "@/lib/bnf/types"
import { CorpusService } from "@/models/corpus/service"
import { DocumentQueries } from "@/models/documents/queries"
import { DocumentService } from "@/models/documents/service"
import { resolvePendingForProject } from "./resolver"

/** Structured log line. Prefix lets ops grep `[canonicalize]`. */
function log(msg: string): void {
  console.log(`[canonicalize] ${msg}`)
}

// ---------------------------------------------------------------------------
// Per-project re-entrancy guard
// ---------------------------------------------------------------------------
// At most one drain runs per project at a time. A drain requested while one is
// active sets `rerun` so the active loop picks up notices queued in the
// meantime, rather than being silently dropped. Same shape as the resolver. The
// map lives on globalThis under a registered symbol: Next.js may evaluate this
// module more than once, and a second copy must share the guard, never hold its
// own beside it.
type ActiveDrains = Map<string, { rerun: boolean }>

const ACTIVE_KEY = Symbol.for("bnf.documents.canonicalizer-active")

function isActiveDrains(v: unknown): v is ActiveDrains {
  return v instanceof Map
}

function activeDrains(): ActiveDrains {
  return processSingleton<ActiveDrains>(ACTIVE_KEY, () => new Map(), isActiveDrains)
}

/** A database await of the drain, bounded by a wall-clock deadline and the caller's signal. */
function bounded<T>(label: string, work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return withDeadline(work, { label: `[canonicalize] ${label}`, ms, signal })
}

/** One sub-batch's BnF window: the per-fan-out budget, cut short by the caller's abort. */
function batchSignal(signal?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(BNF_CANONICALIZE_BUDGET_MS)
  return signal ? AbortSignal.any([signal, budget]) : budget
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Canonicalize all currently-pending catalogue notices for a project.
 * Re-entrant-safe: concurrent calls coalesce into one active drain that
 * re-checks for new pending notices before exiting.
 */
export async function canonicalizePendingForProject(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const active = activeDrains()
  const existing = active.get(projectId)
  if (existing) {
    existing.rerun = true
    return
  }
  const state = { rerun: false }
  active.set(projectId, state)
  try {
    do {
      state.rerun = false
      await drainOnce(projectId, opts?.signal)
    } while (state.rerun && !opts?.signal?.aborted)
  } catch (err) {
    // The caller's abort cut a database await: the drain stopped, nothing
    // failed. Any other error is a real failure.
    if (!(err instanceof DeadlineExceededError && opts?.signal?.aborted)) throw err
    log(`project ${projectId}: aborted mid-drain`)
  } finally {
    active.delete(projectId)
  }
}

/**
 * One drain pass: snapshot the pending notices (bounded), classify them against
 * Gallica, swap the upgraded ones into a single new version, and record the
 * outcome on the rest. Every notice leaves the `pending` state in one pass —
 * upgraded (membership swapped, status cleared), not_digitized, or api_error —
 * so the loop always terminates without an attempts counter.
 */
async function drainOnce(projectId: string, signal?: AbortSignal): Promise<void> {
  const pending = await bounded(
    "pending notices",
    DocumentQueries.pendingCanonicalArks(projectId, CANONICALIZE_DRAIN_MAX),
    DRAINER_DB_TIMEOUT_MS,
    signal,
  )
  if (pending.length === 0) return

  log(`project ${projectId}: classifying ${pending.length} pending notice(s)`)

  const upgrades = new Map<string, string>() // notice ark → canonical Gallica ark
  const notDigitized: string[] = []
  const apiError: string[] = []

  // Classify in bounded sub-batches, each with its own budget window, so a stalled
  // data.bnf.fr/SRU can never hang the drain (CLAUDE_ERROR §14) and the budget
  // stays meaningful per fan-out rather than across the whole pass.
  for (const batch of chunk(pending, CANONICALIZE_BATCH_SIZE)) {
    if (signal?.aborted) {
      log(`project ${projectId}: aborted mid-drain`)
      break
    }
    const client = new BnfDirectClient({ signal: batchSignal(signal) })
    const outcomes = await client.canonicalizeArks(batch)
    for (const o of outcomes) {
      if (o.status === CANONICAL_OUTCOME_STATUS.UPGRADED) upgrades.set(o.ark, o.canonical)
      else if (o.status === CANONICAL_OUTCOME_STATUS.NOT_DIGITIZED) notDigitized.push(o.ark)
      else apiError.push(o.ark)
    }
  }

  // --- Terminal non-upgrades: record the reason (drives the manual promote UI).
  await bounded(
    "canonical verdicts",
    DocumentService.recordCanonicalVerdicts(projectId, { notDigitized, apiError }),
    DRAINER_DB_TIMEOUT_MS,
    signal,
  )

  log(
    `project ${projectId}: upgraded=${upgrades.size}, not_digitized=${notDigitized.length}, api_error=${apiError.length}`,
  )

  if (upgrades.size === 0) return

  // --- Swap the upgraded notices for their digitized docs in ONE new version --
  // Ensure the digitized docs have rows so the membership FK holds.
  const canonicalArks = [...new Set(upgrades.values())]
  const newStubArks = await bounded(
    "canonical stubs",
    DocumentService.createStubs(projectId, canonicalArks),
    DRAINER_DB_TIMEOUT_MS,
    signal,
  )

  // Only notices still in the head are swapped, and the swapped notices' stale
  // pending status is cleared in the same transaction (see swapCanonicalNotices).
  await bounded(
    "membership swap",
    CorpusService.swapCanonicalNotices(projectId, upgrades),
    CANONICALIZE_SWAP_TIMEOUT_MS,
    signal,
  )

  // Resolve the freshly-stubbed digitized docs' metadata. We are already in a
  // detached background task, so invoke the resolver drain directly rather than
  // kickResolve() (which schedules via after() — not valid outside a request).
  // The drain reads the global BnF record cache before it asks the BnF, so a
  // digitized doc any project (or the buffer enricher) already resolved costs
  // no OAI call here, and its own wall-clock ceiling bounds the call.
  if (newStubArks.length > 0) {
    await resolvePendingForProject(projectId, { signal }).catch((err: unknown) => {
      console.error(`[canonicalize] resolve after swap failed (${projectId}):`, err)
    })
  }
}

/**
 * Schedule a canonicalize drain to run after the current response is flushed.
 * Must be called from within a request scope (agent tool handler / route). The
 * request signal is deliberately NOT threaded in — the drain outlives the
 * request; its BnF calls are bounded by BNF_CANONICALIZE_BUDGET_MS.
 */
export function kickCanonicalize(projectId: string): void {
  after(async () => {
    await canonicalizePendingForProject(projectId).catch((err: unknown) => {
      console.error(`[canonicalize] drain failed for project ${projectId}:`, err)
    })
  })
}

/**
 * Boot-time / periodic resume: drain every project that still has pending
 * notices (e.g. left by a restart mid-canonicalization, or a transient BnF
 * outage). Fire-and-forget from instrumentation.ts — never blocks startup.
 */
export async function resumePendingCanonicalize(): Promise<void> {
  const projects = await bounded(
    "projects with pending notices",
    DocumentQueries.projectsWithPendingCanonical(),
    DRAINER_DB_TIMEOUT_MS,
  )
  if (projects.length === 0) return

  log(`resume — draining ${projects.length} project(s) with pending notices`)
  for (const projectId of projects) {
    await canonicalizePendingForProject(projectId).catch((err: unknown) => {
      console.error(`[canonicalize] resume drain failed for project ${projectId}:`, err)
    })
  }
}
