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
  type OcrSyncBatchResult,
  type OcrSyncWritePlan,
} from "./schema"
import {
  OCR_SYNC_BACKOFF_BASE_MS,
  OCR_SYNC_BACKOFF_MAX_MS,
  OCR_SYNC_BUILDING_RECHECK_MS,
  OCR_SYNC_INCOMPATIBLE_RECHECK_MS,
  OCR_SYNC_MAX_ATTEMPTS,
  OCR_SYNC_REJECT_BACKOFF_BASE_MS,
  OCR_SYNC_REJECT_BACKOFF_MAX_MS,
  OCR_SYNC_UNAVAILABLE_RECHECK_MS,
} from "@/lib/constants"
import {
  OCR_QUALITY_ARTIFACT_VERSION,
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  type WorkerSyncAnswer,
} from "@/lib/cluster/ocr-quality"
import { workerRequestTimeoutMs } from "@/lib/cluster/client"
import { ClusterRunner } from "@/lib/cluster/runner"
import { iiifManifestUrl, sourceFromArk } from "@/lib/mcp/vocab"

/**
 * The worker must answer each asked ARK exactly once (the envelope already
 * guarantees "at most once"); an incompatible or broken artifact IS an answer.
 * An ARK left unanswered would stay pending and be re-asked every sweep; an
 * ARK nobody asked for is a contract break. Both throw OcrSyncContractError —
 * nothing of that answer is written. Pure, exported for the tests.
 */
export function assertSyncCoverage(asked: string[], answer: WorkerSyncAnswer): void {
  const answered = new Set([
    ...answer.documents.map((d) => d.ark),
    ...answer.building,
    ...answer.unavailable.map((u) => u.ark),
    ...answer.incompatible.map((i) => i.ark),
    ...answer.broken.map((b) => b.ark),
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
export function planOcrSyncWrites(answer: WorkerSyncAnswer, now: Date): OcrSyncWritePlan {
  return {
    checkedAt: now,
    available: answer.documents.map((d) => ({
      ark: d.ark,
      ocrRate: d.ocrRate,
      folios: d.folios.map((f) => ({
        folio: f.ordre,
        ocrSource: f.ocrSource,
        ocrQuality: f.ocrQuality,
        wordCount: f.wordCount,
      })),
    })),
    building: [...answer.building],
    unavailable: answer.unavailable.map((u) => ({ ark: u.ark, reason: u.reason })),
    incompatible: answer.incompatible.map((i) => ({ ark: i.ark, v: i.v })),
  }
}

/** The reason stored for an ARK whose artifact is another version than the app reads. */
export function incompatibleReason(workerVersion: number): string {
  return `${OCR_SYNC_REASON.INCOMPATIBLE}: worker artifact v${workerVersion}, this app reads v${OCR_QUALITY_ARTIFACT_VERSION}`
}

/**
 * The one exponential schedule of transport and exchange failures (constants
 * OCR_SYNC_BACKOFF_*): base × 2^(failures − 1), capped. Pure, exported for the
 * drainer and the tests.
 */
export function syncBackoffMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error(`syncBackoffMs: failures must be a positive integer, got ${failures}`)
  }
  return Math.min(OCR_SYNC_BACKOFF_BASE_MS * 2 ** (failures - 1), OCR_SYNC_BACKOFF_MAX_MS)
}

/** What a transport failure of an ARK asked ALONE did to its row (DocumentService.recordOcrAloneFailure). */
export const OCR_ALONE_OUTCOME = {
  /** No control this drain: the ARK only backs off; nothing counts against it. */
  BACKOFF: "backoff",
  /** The worker was proven up this drain: one outage strike. */
  STRUCK: "struck",
  /** The strike that reached OCR_SYNC_MAX_ATTEMPTS: quarantined (worker_fails_alone). */
  QUARANTINED: "quarantined",
  /** A newer answer was recorded while the question was in flight: nothing written. */
  STALE: "stale",
} as const
export type OcrAloneOutcome = (typeof OCR_ALONE_OUTCOME)[keyof typeof OCR_ALONE_OUTCOME]

/**
 * Pure: what one more failure that COUNTS against an ARK (a rejection of its
 * answer, or an outage strike) does to its bookkeeping. `priorAttempts`
 * consecutive such failures before this one. At OCR_SYNC_MAX_ATTEMPTS the ARK
 * is quarantined (no automatic recheck); before that it backs off
 * exponentially from the sweep interval, capped.
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
   * the answer covers exactly them, and persist what it says (documents,
   * building, unavailable, incompatible). Returns the plan written — its
   * `checkedAt` is when the question was asked — and the ARKs whose artifact
   * is broken, which the drainer rejects one by one. Throws
   * OcrSyncUnavailableError (the transport failed — nothing is written) or
   * OcrSyncContractError (the exchange, or named ARKs, break the contract —
   * nothing of the answer is written); a DB failure throws as is.
   */
  static async syncOcrBatch(arks: string[], signal: AbortSignal): Promise<OcrSyncBatchResult> {
    // Stamped BEFORE the question: a resync a commit requests while the
    // question is in flight is newer than the answer and stays due.
    const askedAt = new Date()
    const answer = await ClusterRunner.ocrQualitySync(arks, signal)
    assertSyncCoverage(arks, answer)
    const plan = planOcrSyncWrites(answer, askedAt)
    await DocumentService.recordOcrSync(plan, signal)
    return { plan, broken: answer.broken }
  }

  /**
   * Persist one answer. Transactional PER ARK and idempotent: an available
   * ARK's summary upsert, folio delete and folio insert commit together, so a
   * reader never sees a half-replaced document; a replayed answer rewrites the
   * same rows and a re-OCR'd document's folios are replaced wholesale.
   * Building / unavailable / incompatible answers only re-status the summary
   * row — the folios a previous artifact stored stay valid until a new
   * artifact replaces them, and an `available` row answered `incompatible`
   * stays available (its folios are still the last reading this app
   * understands). Every answer resets the rejection count and the outage
   * count and strikes; only an `available` answer satisfies a pending resync
   * request, and one made AFTER the question stays due WHATEVER the answer:
   * keepDueIfResyncedInFlight, in the same transaction.
   */
  static async recordOcrSync(plan: OcrSyncWritePlan, signal: AbortSignal): Promise<void> {
    const { checkedAt } = plan
    const answered = { checkedAt, syncAttempts: 0, outageCount: 0, outageStrikes: 0 }
    for (const doc of plan.available) {
      // Cancellation point between per-ARK transactions (a drain's deadline).
      signal.throwIfAborted()
      const summary = {
        ...answered,
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: doc.ocrRate,
        reason: null,
        syncedAt: checkedAt,
        nextCheckAt: null,
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
      const summary = { ...answered, status: OCR_SYNC_STATUS.BUILDING, reason: null, nextCheckAt: buildingNext }
      // A resync requested while this question was in flight stays due.
      await prisma.$transaction([
        prisma.documentOcr.upsert({ where: { ark }, create: { ark, ...summary }, update: summary }),
        keepDueIfResyncedInFlight(ark, checkedAt),
      ])
    }
    const unavailableNext = new Date(checkedAt.getTime() + OCR_SYNC_UNAVAILABLE_RECHECK_MS)
    for (const { ark, reason } of plan.unavailable) {
      signal.throwIfAborted()
      const summary = { ...answered, status: OCR_SYNC_STATUS.UNAVAILABLE, reason, nextCheckAt: unavailableNext }
      await prisma.$transaction([
        prisma.documentOcr.upsert({ where: { ark }, create: { ark, ...summary }, update: summary }),
        keepDueIfResyncedInFlight(ark, checkedAt),
      ])
    }
    const incompatibleNext = new Date(checkedAt.getTime() + OCR_SYNC_INCOMPATIBLE_RECHECK_MS)
    for (const { ark, v } of plan.incompatible) {
      signal.throwIfAborted()
      const recheck = { ...answered, nextCheckAt: incompatibleNext }
      const summary = { ...recheck, status: OCR_SYNC_STATUS.INCOMPATIBLE, reason: incompatibleReason(v) }
      await prisma.$transaction([
        // An available row keeps its status, reason and folios…
        prisma.documentOcr.updateMany({ where: { ark, status: OCR_SYNC_STATUS.AVAILABLE }, data: recheck }),
        // …any other row (or none) becomes `incompatible`.
        prisma.documentOcr.updateMany({ where: { ark, status: { not: OCR_SYNC_STATUS.AVAILABLE } }, data: summary }),
        prisma.documentOcr.createMany({ data: [{ ark, ...summary }], skipDuplicates: true }),
        keepDueIfResyncedInFlight(ark, checkedAt),
      ])
    }
  }

  /**
   * Record that the worker REJECTED this one ARK's answer — a 400 naming it,
   * an artifact of the expected version that fails its schema, an ARK left
   * out of an otherwise answered batch. `askedAt` is when that question was
   * asked:
   *   - a newer answer recorded since (`checkedAt` > `askedAt`) supersedes
   *     the rejection: nothing is written (an `available` row is only ever
   *     quarantined by the rejection of an answer NEWER than its folios);
   *   - a resync requested since (`resyncRequestedAt` > `askedAt`) keeps the
   *     ARK due whatever the rejection says — the re-ingest may have fixed it;
   *   - otherwise the ARK backs off and, after OCR_SYNC_MAX_ATTEMPTS
   *     consecutive rejections, is quarantined (`sync_rejected: …`): no
   *     automatic recheck until a re-ingest requests a resync. A row that is
   *     `available` keeps its folios; a never-answered ARK becomes
   *     `unavailable` with the reason.
   * A rejection is an answer (the worker was up): it resets the outage count
   * and strikes. Read-modify-write in one transaction.
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
        select: { status: true, checkedAt: true, syncAttempts: true, resyncRequestedAt: true },
      })
      if (row !== null && row.checkedAt > askedAt) return
      const resyncInFlight =
        row !== null && row.resyncRequestedAt !== null && row.resyncRequestedAt > askedAt
      const outcome = rejectionOutcome(row === null ? 0 : row.syncAttempts, now)
      const reason = syncRejectedReason(message)
      const counters = { syncAttempts: outcome.attempts, outageCount: 0, outageStrikes: 0 }
      if (outcome.quarantined) {
        const quarantine = { ...counters, status: OCR_SYNC_STATUS.QUARANTINED, reason, checkedAt: now }
        await tx.documentOcr.upsert({
          where: { ark },
          create: { ark, ...quarantine, nextCheckAt: null },
          // Quarantine never erases a resync request.
          update: { ...quarantine, nextCheckAt: resyncInFlight ? askedAt : null },
        })
        return
      }
      if (row === null) {
        await tx.documentOcr.create({
          data: {
            ark,
            ...counters,
            status: OCR_SYNC_STATUS.UNAVAILABLE,
            reason,
            checkedAt: now,
            nextCheckAt: outcome.nextCheckAt,
          },
        })
        return
      }
      await tx.documentOcr.update({
        where: { ark },
        data: {
          ...counters,
          // An available row keeps its status and folios; a pending one
          // (asked, never answered) is now known to be refused.
          ...(row.status === OCR_SYNC_STATUS.AVAILABLE
            ? {}
            : {
                reason,
                ...(row.status === OCR_SYNC_STATUS.PENDING ? { status: OCR_SYNC_STATUS.UNAVAILABLE } : {}),
              }),
          checkedAt: now,
          nextCheckAt: resyncInFlight ? askedAt : outcome.nextCheckAt,
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
   * Record that a BATCH asked at `askedAt` failed on the transport. That says
   * nothing about any document: no status, folio, rejection count or strike
   * changes, and `next_check_at` is left alone (the drainer paces the corpus's
   * turn instead). Each ARK's outage count goes up by one — the persisted
   * evidence that makes the drainer ask an ARK ALONE once it has failed in a
   * batch twice. A never-asked ARK gets its `pending` row now (due, "not
   * yet"). A row answered after `askedAt` is not counted.
   */
  static async recordOcrBatchOutage(arks: string[], askedAt: Date, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await prisma.$transaction([
      prisma.documentOcr.createMany({
        data: arks.map((ark) => ({
          ark,
          status: OCR_SYNC_STATUS.PENDING,
          checkedAt: askedAt,
          nextCheckAt: askedAt,
        })),
        skipDuplicates: true,
      }),
      prisma.documentOcr.updateMany({
        where: { ark: { in: arks }, checkedAt: { lte: askedAt } },
        data: { outageCount: { increment: 1 } },
      }),
    ])
  }

  /**
   * Record that ONE ARK, asked ALONE at `askedAt`, failed on the transport.
   * `controlled`: another request of the same drain to the same worker was
   * answered, so the worker was up — the failure is this ARK's.
   *   - a newer answer recorded since (`checkedAt` > `askedAt`): nothing is
   *     written (STALE);
   *   - not controlled: the ARK only backs off (syncBackoffMs of its outage
   *     count) — nothing counts against it (BACKOFF);
   *   - controlled: one outage strike, backing off like a rejection
   *     (STRUCK); at OCR_SYNC_MAX_ATTEMPTS strikes it is quarantined with
   *     `worker_fails_alone: …` (QUARANTINED) — except an `available` row,
   *     which is never quarantined by strikes (only a rejection of a NEW
   *     answer can do that) and keeps backing off, capped.
   * A resync requested since `askedAt` keeps the ARK due in every case.
   */
  static async recordOcrAloneFailure(
    ark: string,
    message: string,
    opts: { askedAt: Date; now: Date; controlled: boolean },
    signal: AbortSignal,
  ): Promise<{ outcome: OcrAloneOutcome; strikes: number }> {
    signal.throwIfAborted()
    const { askedAt, now, controlled } = opts
    return prisma.$transaction(async (tx) => {
      await tx.documentOcr.createMany({
        data: [{ ark, status: OCR_SYNC_STATUS.PENDING, checkedAt: askedAt, nextCheckAt: askedAt }],
        skipDuplicates: true,
      })
      const row = await tx.documentOcr.findUniqueOrThrow({
        where: { ark },
        select: {
          status: true,
          checkedAt: true,
          resyncRequestedAt: true,
          outageCount: true,
          outageStrikes: true,
        },
      })
      if (row.checkedAt > askedAt) return { outcome: OCR_ALONE_OUTCOME.STALE, strikes: row.outageStrikes }
      const resyncInFlight = row.resyncRequestedAt !== null && row.resyncRequestedAt > askedAt
      const outageCount = row.outageCount + 1
      if (!controlled) {
        const nextCheckAt = new Date(now.getTime() + syncBackoffMs(outageCount))
        await tx.documentOcr.update({
          where: { ark },
          data: { outageCount, nextCheckAt: resyncInFlight ? askedAt : nextCheckAt },
        })
        return { outcome: OCR_ALONE_OUTCOME.BACKOFF, strikes: row.outageStrikes }
      }
      const strike = rejectionOutcome(row.outageStrikes, now)
      if (strike.quarantined && row.status !== OCR_SYNC_STATUS.AVAILABLE) {
        await tx.documentOcr.update({
          where: { ark },
          data: {
            outageCount,
            outageStrikes: strike.attempts,
            status: OCR_SYNC_STATUS.QUARANTINED,
            reason: `${OCR_SYNC_REASON.WORKER_FAILS_ALONE}: ${message}`,
            // Quarantine never erases a resync request.
            nextCheckAt: resyncInFlight ? askedAt : null,
          },
        })
        return { outcome: OCR_ALONE_OUTCOME.QUARANTINED, strikes: strike.attempts }
      }
      const backoff = strike.nextCheckAt ?? new Date(now.getTime() + OCR_SYNC_REJECT_BACKOFF_MAX_MS)
      await tx.documentOcr.update({
        where: { ark },
        data: {
          outageCount,
          outageStrikes: strike.attempts,
          nextCheckAt: resyncInFlight ? askedAt : backoff,
        },
      })
      return { outcome: OCR_ALONE_OUTCOME.STRUCK, strikes: strike.attempts }
    })
  }

  /**
   * The write a re-ingest commit adds to its own transaction
   * (IngestService.commit / commitPartialFailure): every committed ARK that
   * already has a DocumentOcr row is due again NOW and gets a fresh rejection,
   * outage and strike budget, because the re-run may have re-OCR'd it. Persisted, so a restart
   * or a worker outage loses nothing; ARKs without a row are pending anyway.
   */
  static ocrResyncOp(arks: string[], now: Date): Prisma.PrismaPromise<Prisma.BatchPayload> {
    return prisma.documentOcr.updateMany({
      where: { ark: { in: arks } },
      data: { resyncRequestedAt: now, nextCheckAt: now, syncAttempts: 0, outageCount: 0, outageStrikes: 0 },
    })
  }
}
