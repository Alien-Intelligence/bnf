// models/documents/service.ts
// Business logic for document mutations.
// Used by the seed script (commit #10) and, in slice 3, by the MCP resolve
// path when the agent adds ARKs that don't yet have Document rows.
import "server-only"

import { prisma } from "@/lib/db"
import {
  DOCUMENT_RESOLVE_STATUS,
  OCR_SYNC_STATUS,
  type DocumentUpsertData,
  type OcrSource,
} from "./schema"
import type { WorkerOcrQualitySyncResponse } from "./types"
import { ClusterRunner } from "@/lib/cluster/runner"
import { iiifManifestUrl, sourceFromArk } from "@/lib/mcp/vocab"

/**
 * What one worker sync answer writes, per ARK (DocumentService.recordOcrSync):
 *   available   → replace the ARK's folios and mark it available;
 *   building    → status only (folios left as they are);
 *   unavailable → status + reason only (folios left as they are).
 * `checkedAt` is the time of the answer, stamped on every row.
 */
export type OcrSyncWritePlan = {
  checkedAt: Date
  available: Array<{
    ark: string
    ocrRate: number | null
    folios: Array<{
      folio: number
      ocrSource: OcrSource
      ocrQuality: number | null
      wordCount: number | null
    }>
  }>
  building: string[]
  unavailable: Array<{ ark: string; reason: string }>
}

/**
 * The worker must answer each asked ARK exactly once (the schema already
 * guarantees "at most once"). An ARK left unanswered would stay pending and be
 * re-asked every sweep; an ARK nobody asked for is a contract break. Both
 * throw — nothing of that answer is written. Pure, exported for the tests.
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
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `ocr-quality sync answer does not match the request: missing=[${missing.join(", ")}] unexpected=[${extra.join(", ")}]`,
    )
  }
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
   * written so the drainer can tally it. Any failure — transport, non-2xx,
   * invalid body, coverage, DB — throws to the caller; the rows stay as they
   * were and the next sweep re-asks.
   */
  static async syncOcrBatch(arks: string[]): Promise<OcrSyncWritePlan> {
    const response = await ClusterRunner.ocrQualitySync(arks)
    assertSyncCoverage(arks, response)
    const plan = planOcrSyncWrites(response, new Date())
    await DocumentService.recordOcrSync(plan)
    return plan
  }

  /**
   * Persist one OCR-quality sync answer (lib/documents/ocr-sync.ts).
   *
   * Transactional PER ARK and idempotent: an available ARK's summary upsert,
   * folio delete and folio insert commit together, so a reader never sees a
   * half-replaced document; a replayed answer rewrites the same rows and a
   * re-OCR'd document's folios are replaced wholesale. Building / unavailable
   * entries only re-status the summary row — the folios a previous artifact
   * stored stay valid until a new artifact replaces them.
   */
  static async recordOcrSync(plan: OcrSyncWritePlan): Promise<void> {
    const { checkedAt } = plan
    for (const doc of plan.available) {
      await prisma.$transaction([
        prisma.documentOcr.upsert({
          where: { ark: doc.ark },
          create: {
            ark: doc.ark,
            status: OCR_SYNC_STATUS.AVAILABLE,
            ocrRate: doc.ocrRate,
            reason: null,
            checkedAt,
            syncedAt: checkedAt,
          },
          update: {
            status: OCR_SYNC_STATUS.AVAILABLE,
            ocrRate: doc.ocrRate,
            reason: null,
            checkedAt,
            syncedAt: checkedAt,
          },
        }),
        prisma.documentFolio.deleteMany({ where: { ark: doc.ark } }),
        prisma.documentFolio.createMany({
          data: doc.folios.map((f) => ({ ark: doc.ark, ...f })),
        }),
      ])
    }
    for (const ark of plan.building) {
      await prisma.documentOcr.upsert({
        where: { ark },
        create: { ark, status: OCR_SYNC_STATUS.BUILDING, reason: null, checkedAt },
        update: { status: OCR_SYNC_STATUS.BUILDING, reason: null, checkedAt },
      })
    }
    for (const { ark, reason } of plan.unavailable) {
      await prisma.documentOcr.upsert({
        where: { ark },
        create: { ark, status: OCR_SYNC_STATUS.UNAVAILABLE, reason, checkedAt },
        update: { status: OCR_SYNC_STATUS.UNAVAILABLE, reason, checkedAt },
      })
    }
  }
}
