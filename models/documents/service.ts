// models/documents/service.ts
// Business logic for document mutations.
// Used by the seed script (commit #10) and, in slice 3, by the MCP resolve
// path when the agent adds ARKs that don't yet have Document rows.
import "server-only"

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import {
  DOCUMENT_RESOLVE_STATUS,
  OCR_SYNC_REASON,
  OCR_SYNC_STATUS,
  type DocumentUpsertData,
  type OcrSyncWritePlan,
} from "./schema"
import {
  OCR_SYNC_BUILDING_RECHECK_MS,
  OCR_SYNC_MAX_ATTEMPTS,
  OCR_SYNC_OUTAGE_BACKOFF_MS,
  OCR_SYNC_REJECT_BACKOFF_BASE_MS,
  OCR_SYNC_REJECT_BACKOFF_MAX_MS,
  OCR_SYNC_UNAVAILABLE_RECHECK_MS,
} from "@/lib/constants"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  type WorkerOcrQualitySyncResponse,
} from "@/lib/cluster/ocr-quality"
import { workerRequestTimeoutMs } from "@/lib/cluster/client"
import { ClusterRunner } from "@/lib/cluster/runner"
import { iiifManifestUrl, sourceFromArk } from "@/lib/mcp/vocab"

/**
 * The worker must answer each asked ARK exactly once (the schema already
 * guarantees "at most once"). An ARK left unanswered would stay pending and be
 * re-asked every sweep; an ARK nobody asked for is a contract break. Both
 * throw OcrSyncContractError — nothing of that answer is written. Pure,
 * exported for the tests.
 */
export function assertSyncCoverage(
  asked: string[],
  response: WorkerOcrQualitySyncResponse,
): void {
  const answered = new Set([
    ...response.documents.map((d) => d.ark),
    ...response.building,
    ...response.unavailable.map((u) => u.ark),
  ])
  const askedSet = new Set(asked)
  const missing = [...askedSet].filter((a) => !answered.has(a))
  const extra = [...answered].filter((a) => !askedSet.has(a))
  if (missing.length === 0 && extra.length === 0) return
  const message = `ocr-quality sync answer does not match the request: missing=[${missing.join(", ")}] unexpected=[${extra.join(", ")}]`
  // An ARK nobody asked for, or an answer that answers NOTHING of what was
  // asked, is the exchange's fault (a worker that cannot speak this contract —
  // never a reason to penalise every ARK of the batch). ARKs left unanswered
  // in an otherwise answered batch are pinned on themselves.
  const answeredNothing = missing.length === askedSet.size
  throw new OcrSyncContractError(
    message,
    extra.length > 0 || answeredNothing
      ? { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] }
      : { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits: missing },
  )
}

/**
 * Pure: a validated worker answer → the write plan. Exported for the tests
 * (tests/models/documents/ocr.test.ts) — the no-Prisma-mocking precedent.
 */
export function planOcrSyncWrites(
  response: WorkerOcrQualitySyncResponse,
  now: Date,
): OcrSyncWritePlan {
  return {
    checkedAt: now,
    available: response.documents.map((d) => ({
      ark: d.ark,
      ocrRate: d.ocrRate,
      folios: d.folios.map((f) => ({
        folio: f.ordre,
        ocrSource: f.ocrSource,
        ocrQuality: f.ocrQuality,
        wordCount: f.wordCount,
      })),
    })),
    building: [...response.building],
    unavailable: response.unavailable.map((u) => ({ ark: u.ark, reason: u.reason })),
  }
}

/**
 * Pure: what a contract failure of one ARK's sync does to its bookkeeping.
 * `priorAttempts` consecutive failures before this one. At
 * OCR_SYNC_MAX_ATTEMPTS the ARK is quarantined (no automatic recheck);
 * before that it backs off exponentially from the sweep interval, capped.
 */
export function rejectionOutcome(
  priorAttempts: number,
  now: Date,
): { attempts: number; quarantined: boolean; nextCheckAt: Date | null } {
  if (!Number.isInteger(priorAttempts) || priorAttempts < 0) {
    throw new Error(`rejectionOutcome: priorAttempts must be a non-negative integer, got ${priorAttempts}`)
  }
  const attempts = priorAttempts + 1
  if (attempts >= OCR_SYNC_MAX_ATTEMPTS) return { attempts, quarantined: true, nextCheckAt: null }
  const delay = Math.min(
    OCR_SYNC_REJECT_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    OCR_SYNC_REJECT_BACKOFF_MAX_MS,
  )
  return { attempts, quarantined: false, nextCheckAt: new Date(now.getTime() + delay) }
}

/** The reason stored for an ARK whose sync broke the worker contract. */
export function syncRejectedReason(message: string): string {
  return `${OCR_SYNC_REASON.REJECTED}: ${message}`
}

/**
 * The write that keeps an ARK due when a resync was requested while its
 * question was in flight (after `checkedAt`, the stamp taken before the
 * request): the answer may predate the re-OCR, so it never pushes that
 * request's recheck out.
 */
function keepDueIfResyncedInFlight(ark: string, checkedAt: Date): Prisma.PrismaPromise<Prisma.BatchPayload> {
  return prisma.documentOcr.updateMany({
    where: { ark, resyncRequestedAt: { gt: checkedAt } },
    data: { nextCheckAt: checkedAt },
  })
}

export class DocumentService {
  /**
   * Bulk-upserts document metadata rows.
   *
   * `skipDuplicates: true` makes the operation idempotent — re-seeding or
   * re-resolving the same ARK is safe. Existing rows are NOT updated; a
   * deliberate re-resolve (slice 3) should use an explicit update instead.
   *
   * Used by:
   *  - `prisma/seed.ts` (slice 1) to pre-create rows so CorpusService.addArks
   *    can reference them without MCP.
   *  - `models/agents/service.ts` (slice 3) after MCP bnf.resolve() returns
   *    document metadata for a new ARK.
   */
  static async upsertMany(
    projectId: string,
    docs: Array<Omit<DocumentUpsertData, "projectId">>,
  ): Promise<void> {
    if (docs.length === 0) return

    await prisma.document.createMany({
      // These rows carry full metadata, so they are born "resolved" — the
      // drainer must not pick them up. (createMany default would be "pending".)
      data: docs.map((d) => ({
        resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
        resolvedAt: new Date(),
        ...d,
        projectId,
      })),
      skipDuplicates: true,
    })
  }

  /**
   * Insert "stub" Document rows for ARKs being added to the corpus, carrying
   * only what is derivable from the ARK itself (source + IIIF manifest URL).
   * Metadata (title, year, lang, docType, …) is filled in later by the
   * background resolver. Idempotent: `skipDuplicates` means an ARK that already
   * has a row (stub or resolved) is left untouched.
   *
   * Returns the ARKs that were newly inserted (i.e. had no prior row), so the
   * caller can report how many are now pending.
   */
  static async createStubs(projectId: string, arks: string[]): Promise<string[]> {
    if (arks.length === 0) return []

    // Only the ARKs without an existing row become new stubs.
    const existing = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: { ark: true },
    })
    const existingSet = new Set(existing.map((d) => d.ark))
    const newArks = arks.filter((a) => !existingSet.has(a))
    if (newArks.length === 0) return []

    await prisma.document.createMany({
      data: newArks.map((ark) => {
        const source = sourceFromArk(ark)
        return {
          projectId,
          ark,
          source,
          iiifManifestUrl: iiifManifestUrl(ark, source),
          resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
        }
      }),
      skipDuplicates: true,
    })
    return newArks
  }

  /**
   * Re-queue metadata resolution for the given ARKs: flip them back to `pending`
   * and reset the attempt counter so the background resolver picks them up on the
   * next kick. Used by the manual "retry" affordance on a failed document and by
   * the panel's auto-retry on first paint.
   *
   * Scoped to the project and to documents currently in a terminal/limbo state
   * (`failed`, or `pending` with attempts exhausted) — a row mid-resolution is
   * left alone. Returns the number of rows actually re-queued so the caller knows
   * whether to kick the resolver.
   */
  static async retryResolution(
    projectId: string,
    arks: string[],
  ): Promise<{ retried: number }> {
    if (arks.length === 0) return { retried: 0 }

    const res = await prisma.document.updateMany({
      where: {
        projectId,
        ark: { in: arks },
        resolveStatus: { not: DOCUMENT_RESOLVE_STATUS.RESOLVED },
      },
      data: {
        resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
        resolveAttempts: 0,
        resolveError: null,
      },
    })
    return { retried: res.count }
  }

  /**
   * One sync batch: ask the worker about `arks` (≤ OCR_SYNC_BATCH_SIZE), check
   * the answer covers exactly them, and persist it. Returns the plan that was
   * written so the drainer can tally it. Throws OcrSyncUnavailableError (worker
   * not reachable — nothing is written, nothing is penalised) or
   * OcrSyncContractError (the answer breaks the contract — the drainer
   * isolates and penalises the ARK at fault); a DB failure throws as is.
   */
  static async syncOcrBatch(arks: string[], signal: AbortSignal): Promise<OcrSyncWritePlan> {
    // Stamped BEFORE the question: a resync a commit requests while the
    // question is in flight is newer than the answer and stays due.
    const askedAt = new Date()
    const response = await ClusterRunner.ocrQualitySync(arks, signal)
    assertSyncCoverage(arks, response)
    const plan = planOcrSyncWrites(response, askedAt)
    await DocumentService.recordOcrSync(plan, signal)
    return plan
  }

  /**
   * Persist one valid sync answer. Transactional PER ARK and idempotent: an
   * available ARK's summary upsert, folio delete and folio insert commit
   * together, so a reader never sees a half-replaced document; a replayed
   * answer rewrites the same rows and a re-OCR'd document's folios are
   * replaced wholesale. Building / unavailable answers only re-status the
   * summary row — the folios a previous artifact stored stay valid until a
   * new artifact replaces them. Every valid answer resets the contract-failure
   * count; only an `available` answer satisfies a pending resync request, and
   * one made AFTER the question stays due WHATEVER the answer (available,
   * building or unavailable): keepDueIfResyncedInFlight, in the same transaction.
   */
  static async recordOcrSync(plan: OcrSyncWritePlan, signal: AbortSignal): Promise<void> {
    const { checkedAt } = plan
    for (const doc of plan.available) {
      // Cancellation point between per-ARK transactions (a drain's deadline).
      signal.throwIfAborted()
      const summary = {
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: doc.ocrRate,
        reason: null,
        checkedAt,
        syncedAt: checkedAt,
        nextCheckAt: null,
        syncAttempts: 0,
      }
      await prisma.$transaction([
        prisma.documentOcr.upsert({
          where: { ark: doc.ark },
          create: { ark: doc.ark, ...summary },
          update: summary,
        }),
        prisma.documentFolio.deleteMany({ where: { ark: doc.ark } }),
        prisma.documentFolio.createMany({
          data: doc.folios.map((f) => ({ ark: doc.ark, ...f })),
        }),
        // A resync requested before this question is now satisfied…
        prisma.documentOcr.updateMany({
          where: { ark: doc.ark, resyncRequestedAt: { lte: checkedAt } },
          data: { resyncRequestedAt: null },
        }),
        // …one requested while it was in flight keeps the row due.
        keepDueIfResyncedInFlight(doc.ark, checkedAt),
      ])
    }
    const buildingNext = new Date(checkedAt.getTime() + OCR_SYNC_BUILDING_RECHECK_MS)
    for (const ark of plan.building) {
      signal.throwIfAborted()
      const summary = {
        status: OCR_SYNC_STATUS.BUILDING,
        reason: null,
        checkedAt,
        nextCheckAt: buildingNext,
        syncAttempts: 0,
      }
      // A resync requested while this question was in flight stays due.
      await prisma.$transaction([
        prisma.documentOcr.upsert({ where: { ark }, create: { ark, ...summary }, update: summary }),
        keepDueIfResyncedInFlight(ark, checkedAt),
      ])
    }
    const unavailableNext = new Date(checkedAt.getTime() + OCR_SYNC_UNAVAILABLE_RECHECK_MS)
    for (const { ark, reason } of plan.unavailable) {
      signal.throwIfAborted()
      const summary = {
        status: OCR_SYNC_STATUS.UNAVAILABLE,
        reason,
        checkedAt,
        nextCheckAt: unavailableNext,
        syncAttempts: 0,
      }
      await prisma.$transaction([
        prisma.documentOcr.upsert({ where: { ark }, create: { ark, ...summary }, update: summary }),
        keepDueIfResyncedInFlight(ark, checkedAt),
      ])
    }
  }

  /**
   * Record that the worker's answer for this ONE ARK broke the contract (the
   * drainer isolated it by splitting the batch). The ARK backs off and, after
   * OCR_SYNC_MAX_ATTEMPTS consecutive failures, is quarantined — no automatic
   * recheck until a re-ingest requests a resync. A row that is `available`
   * keeps its status and folios (they are still valid) and only backs off; a
   * never-synced ARK becomes `unavailable` with the reason. Read-modify-write
   * in one transaction.
   */
  static async recordOcrRejection(
    ark: string,
    message: string,
    now: Date,
    askedAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await prisma.$transaction(async (tx) => {
      const row = await tx.documentOcr.findUnique({
        where: { ark },
        select: { status: true, syncAttempts: true, resyncRequestedAt: true },
      })
      // A resync beats a quarantine: one requested while this question was in
      // flight (after `askedAt`) keeps the ARK due whatever the rejection says
      // — the re-ingest may have fixed what the worker refused.
      const resyncInFlight =
        row !== null && row.resyncRequestedAt !== null && row.resyncRequestedAt > askedAt
      const prior = row === null ? 0 : row.syncAttempts
      const outcome = rejectionOutcome(prior, now)
      const reason = syncRejectedReason(message)
      if (outcome.quarantined) {
        await tx.documentOcr.upsert({
          where: { ark },
          create: {
            ark,
            status: OCR_SYNC_STATUS.QUARANTINED,
            reason,
            checkedAt: now,
            nextCheckAt: null,
            syncAttempts: outcome.attempts,
          },
          update: {
            status: OCR_SYNC_STATUS.QUARANTINED,
            reason,
            checkedAt: now,
            // Quarantine never erases a resync request.
            nextCheckAt: resyncInFlight ? askedAt : null,
            syncAttempts: outcome.attempts,
          },
        })
        return
      }
      if (row === null) {
        await tx.documentOcr.create({
          data: {
            ark,
            status: OCR_SYNC_STATUS.UNAVAILABLE,
            reason,
            checkedAt: now,
            nextCheckAt: outcome.nextCheckAt,
            syncAttempts: outcome.attempts,
          },
        })
        return
      }
      await tx.documentOcr.update({
        where: { ark },
        data: {
          ...(row.status === OCR_SYNC_STATUS.AVAILABLE ? {} : { reason }),
          checkedAt: now,
          nextCheckAt: resyncInFlight ? askedAt : outcome.nextCheckAt,
          syncAttempts: outcome.attempts,
        },
      })
    })
  }

  /**
   * The worker's request timeout — the drainer's worst-case cost of one batch
   * comes through the service, so the drainer does not reach the cluster client.
   */
  static ocrSyncRequestTimeoutMs(): number {
    return workerRequestTimeoutMs()
  }

  /**
   * Record that the worker could not be ASKED about these ARKs (unreachable,
   * timeout, a 5xx): rows back off for OCR_SYNC_OUTAGE_BACKOFF_MS and keep
   * their status, folios and contract-failure budget (an outage says nothing
   * about the documents). A never-asked ARK gets NO row: it stays pending
   * ("not yet"), never `unavailable` ("maybe never"); the drainer keeps its
   * own per-ARK outage count for those (lib/documents/ocr-sync.ts).
   */
  static async recordOcrOutage(arks: string[], now: Date, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const nextCheckAt = new Date(now.getTime() + OCR_SYNC_OUTAGE_BACKOFF_MS)
    await prisma.documentOcr.updateMany({ where: { ark: { in: arks } }, data: { nextCheckAt } })
  }

  /**
   * Take out of the rotation an ARK the worker reliably fails on ALONE (the
   * drainer cornered it by asking both halves of a batch down to one ARK, and
   * its singleton failed OCR_SYNC_MAX_ATTEMPTS outages): quarantined with
   * `sync_isolated: …`, no automatic recheck — a re-ingest's resync request
   * re-opens it (ocrResyncOp). A row's folios are kept.
   */
  static async recordOcrIsolation(ark: string, message: string, now: Date, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const reason = `${OCR_SYNC_REASON.ISOLATED}: ${message}`
    await prisma.documentOcr.upsert({
      where: { ark },
      create: { ark, status: OCR_SYNC_STATUS.QUARANTINED, reason, checkedAt: now, nextCheckAt: null },
      update: { status: OCR_SYNC_STATUS.QUARANTINED, reason, checkedAt: now, nextCheckAt: null },
    })
  }

  /**
   * The write a re-ingest commit adds to its own transaction
   * (IngestService.commit / commitPartialFailure): every committed ARK that
   * already has a DocumentOcr row is due again NOW and gets a fresh attempt
   * budget, because the re-run may have re-OCR'd it. Persisted, so a restart
   * or a worker outage loses nothing; ARKs without a row are pending anyway.
   */
  static ocrResyncOp(arks: string[], now: Date): Prisma.PrismaPromise<Prisma.BatchPayload> {
    return prisma.documentOcr.updateMany({
      where: { ark: { in: arks } },
      data: { resyncRequestedAt: now, nextCheckAt: now, syncAttempts: 0 },
    })
  }
}
