// models/documents/types.ts
// Zod schemas for document API request/query validation, and for the one wire
// contract the documents model consumes: worker-v2's POST /ocr-quality/sync.
//
// No imports from other model directories (playbook/models.md import diagram):
// `arkSchema` is redefined here, as models/buffer/types.ts does, rather than
// imported from models/corpus/types.ts.

import { z } from "zod"

import { OCR_SYNC_MAX_FOLIOS_PER_DOC } from "@/lib/constants"
import { OCR_SOURCE, type OcrSource } from "./schema"

/** ark:/<NAAN>/<name>, e.g. ark:/12148/bpt6k2839841. */
const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

/**
 * Query params for the document detail endpoint.
 * Placeholder — extended in slice 2 when the detail route ships.
 */
export const documentDetailQuerySchema = z.object({
  // No query params yet; shape extended in slice 2.
})

export type DocumentDetailQuery = z.infer<typeof documentDetailQuerySchema>

/** GET /api/projects/[id]/documents/ocr?ark= */
export const documentOcrQuerySchema = z.object({ ark: arkSchema })
export type DocumentOcrQuery = z.infer<typeof documentOcrQuerySchema>

// ---------------------------------------------------------------------------
// worker-v2 POST /ocr-quality/sync response
//
// WIRE CONTRACT with worker-v2/src/domain/types.ts (DocOcrQuality,
// FolioOcrQuality) and worker-v2/src/live/ocr-quality-sync.ts (OcrSyncResponse).
// Change both sides together. The worker's own invariants are re-checked here
// rather than trusted (plan D2): what is parsed is what gets stored.
// ---------------------------------------------------------------------------

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

/** The worker lane that prepared the document → the only source its folios may carry. */
const WORKER_LANE_SOURCE = {
  text: OCR_SOURCE.ALTO,
  mistral: OCR_SOURCE.MISTRAL,
  vision: OCR_SOURCE.VISION,
} as const satisfies Record<string, OcrSource>

const workerLaneSchema = z.enum(["text", "mistral", "vision"])

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
    const expected = WORKER_LANE_SOURCE[doc.lane]
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

export const workerOcrQualitySyncResponseSchema = z
  .object({
    documents: z.array(workerDocOcrQualitySchema),
    building: z.array(arkSchema),
    unavailable: z.array(z.object({ ark: arkSchema, reason: z.string().min(1) })),
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
