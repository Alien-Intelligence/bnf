// lib/cluster/ocr-quality.ts
// The worker-v2 POST /ocr-quality/sync wire contract (feedback 2026-09-29 #7,
// Track B) and the two typed failures of a sync call.
//
// WIRE CONTRACT with worker-v2/src/domain/types.ts (DocOcrQuality,
// FolioOcrQuality, Lane) and worker-v2/src/live/ocr-quality-sync.ts
// (OcrSyncResponse). Change both sides together. The worker's invariants are
// re-checked here rather than trusted (plan D2): what is parsed is what gets
// stored.

import { z } from "zod"

import { OCR_SYNC_BATCH_SIZE, OCR_SYNC_MAX_FOLIOS_PER_DOC } from "@/lib/constants"
import { arkSchema } from "@/lib/validation/ark"
import { OCR_SOURCE, type OcrSource } from "@/models/documents/schema"

/** The worker lanes (worker-v2 `Lane`): which pipeline prepared a document. */
export const WORKER_LANE = {
  TEXT: "text",
  MISTRAL: "mistral",
  VISION: "vision",
} as const
export type WorkerLane = (typeof WORKER_LANE)[keyof typeof WORKER_LANE]

/** A lane → the only OCR source its folios may carry. */
const LANE_SOURCE = {
  [WORKER_LANE.TEXT]: OCR_SOURCE.ALTO,
  [WORKER_LANE.MISTRAL]: OCR_SOURCE.MISTRAL,
  [WORKER_LANE.VISION]: OCR_SOURCE.VISION,
} as const satisfies Record<WorkerLane, OcrSource>

const workerLaneSchema = z.enum([WORKER_LANE.TEXT, WORKER_LANE.MISTRAL, WORKER_LANE.VISION])

/** A WC mean, a "Taux OCR" fraction: a finite number in [0, 1]. */
const unitInterval = z.number().min(0).max(1)

/**
 * One prepared folio. The source decides which fields may carry a value:
 *   alto            → wordCount is a count (≥ 0), ocrQuality a mean or null
 *                     (an ALTO page without WC);
 *   mistral, vision → both null — a Mistral word count is not comparable to
 *                     an ALTO one, and neither source has a word confidence.
 */
const workerFolioOcrSchema = z.discriminatedUnion("ocrSource", [
  z.object({
    ordre: z.number().int().positive(),
    ocrSource: z.literal(OCR_SOURCE.ALTO),
    ocrQuality: unitInterval.nullable(),
    wordCount: z.number().int().nonnegative(),
  }),
  z.object({
    ordre: z.number().int().positive(),
    ocrSource: z.literal(OCR_SOURCE.MISTRAL),
    ocrQuality: z.null(),
    wordCount: z.null(),
  }),
  z.object({
    ordre: z.number().int().positive(),
    ocrSource: z.literal(OCR_SOURCE.VISION),
    ocrQuality: z.null(),
    wordCount: z.null(),
  }),
])

/** One per-ARK artifact (worker DocOcrQuality). */
const workerDocOcrQualitySchema = z
  .object({
    v: z.literal(1),
    ark: arkSchema,
    ocrRate: unitInterval.nullable(),
    lane: workerLaneSchema,
    folios: z.array(workerFolioOcrSchema).max(OCR_SYNC_MAX_FOLIOS_PER_DOC),
    builtAt: z.iso.datetime(),
  })
  .superRefine((doc, ctx) => {
    const expected = LANE_SOURCE[doc.lane]
    const seen = new Set<number>()
    doc.folios.forEach((f, i) => {
      if (f.ocrSource !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["folios", i, "ocrSource"],
          message: `lane ${doc.lane} folio must be ${expected}, got ${f.ocrSource}`,
        })
      }
      if (seen.has(f.ordre)) {
        ctx.addIssue({
          code: "custom",
          path: ["folios", i, "ordre"],
          message: `duplicate folio ${f.ordre}`,
        })
      }
      seen.add(f.ordre)
    })
  })

/** The whole answer: at most one batch of ARKs, each answered exactly once. */
export const workerOcrQualitySyncResponseSchema = z
  .object({
    documents: z.array(workerDocOcrQualitySchema).max(OCR_SYNC_BATCH_SIZE),
    building: z.array(arkSchema).max(OCR_SYNC_BATCH_SIZE),
    unavailable: z
      .array(z.object({ ark: arkSchema, reason: z.string().min(1) }))
      .max(OCR_SYNC_BATCH_SIZE),
  })
  .superRefine((res, ctx) => {
    // Each ARK is answered exactly once: an ARK in two buckets would make the
    // write plan both replace and re-status it.
    const seen = new Set<string>()
    const arks = [
      ...res.documents.map((d) => d.ark),
      ...res.building,
      ...res.unavailable.map((u) => u.ark),
    ]
    for (const ark of arks) {
      if (seen.has(ark)) {
        ctx.addIssue({ code: "custom", message: `ARK ${ark} answered more than once` })
      }
      seen.add(ark)
    }
  })
export type WorkerOcrQualitySyncResponse = z.infer<typeof workerOcrQualitySyncResponseSchema>

// ---------------------------------------------------------------------------
// Typed failures of a sync call — the drainer (lib/documents/ocr-sync.ts)
// treats them differently, so they must never be told apart by message.
// ---------------------------------------------------------------------------

/**
 * The worker could not be asked: transport error, timeout, a 5xx, or a 404
 * from a worker older than the endpoint. Says nothing about the ARKs — the
 * cycle stops and the next sweep asks again; no ARK is penalised.
 */
export class OcrSyncUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OcrSyncUnavailableError"
  }
}

/**
 * The worker answered, but the answer breaks the contract: a 400 (an ARK it
 * refuses), a body that is not a valid sync response, or one that does not
 * answer exactly the ARKs asked. Deterministic for the batch — the drainer
 * splits the batch to isolate the ARK at fault and quarantines it after
 * repeated failures, so one poison ARK cannot starve the sweep.
 */
export class OcrSyncContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OcrSyncContractError"
  }
}
