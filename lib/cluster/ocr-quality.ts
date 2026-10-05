// lib/cluster/ocr-quality.ts
// The worker-v2 POST /ocr-quality/sync wire contract (feedback 2026-09-29 #7,
// Track B) and the two typed failures of a sync call.
//
// WIRE CONTRACT with worker-v2/src/domain/types.ts (DocOcrQuality,
// FolioOcrQuality, Lane) and worker-v2/src/live/ocr-quality-sync.ts
// (OcrSyncResponse). Change both sides together. The worker's invariants are
// re-checked here rather than trusted (plan D2): what is parsed is what gets
// stored.
//
// THE VERSION RULE: every change to the artifact's shape or meaning bumps its
// `v` (worker-v2/src/stages/ocr-quality.ts states the same rule). An answer is
// read in two layers, by evidence:
//   - the ENVELOPE ({documents, building, unavailable}, each document an object
//     with an `ark` and an integer `v`) must parse, else the exchange itself is
//     broken (OcrSyncContractError EXCHANGE: the sync pauses);
//   - each DOCUMENT is judged on its own: another `v` than
//     OCR_QUALITY_ARTIFACT_VERSION → `incompatible` (a deploy mismatch: nobody
//     is blamed, retried later); the expected `v` but failing the schema →
//     that artifact is broken (`broken`: that ARK alone is rejected).

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

/** The artifact version this app reads (worker DocOcrQuality `v`). */
export const OCR_QUALITY_ARTIFACT_VERSION = 1

/** One per-ARK artifact (worker DocOcrQuality). */
export const workerDocOcrQualitySchema = z
  .object({
    v: z.literal(OCR_QUALITY_ARTIFACT_VERSION),
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

/** Each ARK is answered exactly once across the buckets. */
function uniqueArks(arks: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const ark of arks) {
    if (seen.has(ark)) ctx.addIssue({ code: "custom", message: `ARK ${ark} answered more than once` })
    seen.add(ark)
  }
}

export type WorkerDocOcrQuality = z.infer<typeof workerDocOcrQualitySchema>

/** The envelope layer: what must parse for the answer to be an answer at all. */
const workerSyncEnvelopeSchema = z
  .object({
    documents: z.array(z.looseObject({ ark: arkSchema, v: z.number().int() })).max(OCR_SYNC_BATCH_SIZE),
    building: z.array(arkSchema).max(OCR_SYNC_BATCH_SIZE),
    unavailable: z
      .array(z.object({ ark: arkSchema, reason: z.string().min(1) }))
      .max(OCR_SYNC_BATCH_SIZE),
  })
  .superRefine((res, ctx) =>
    uniqueArks(
      [...res.documents.map((d) => d.ark), ...res.building, ...res.unavailable.map((u) => u.ark)],
      ctx,
    ),
  )

/** A sync answer read document by document (see the header). */
export type WorkerSyncAnswer = {
  documents: WorkerDocOcrQuality[]
  building: string[]
  unavailable: Array<{ ark: string; reason: string }>
  /** Artifacts of another version: a deploy mismatch, nobody blamed. */
  incompatible: Array<{ ark: string; v: number }>
  /** Artifacts of the expected version that fail its schema: that ARK alone is at fault. */
  broken: Array<{ ark: string; message: string }>
}

/** Read a worker answer: the envelope must parse; each document is then judged alone. */
export function readWorkerSyncAnswer(
  raw: unknown,
): { ok: true; answer: WorkerSyncAnswer } | { ok: false; message: string } {
  const envelope = workerSyncEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { ok: false, message: z.prettifyError(envelope.error) }
  const answer: WorkerSyncAnswer = {
    documents: [],
    building: envelope.data.building,
    unavailable: envelope.data.unavailable,
    incompatible: [],
    broken: [],
  }
  for (const doc of envelope.data.documents) {
    if (doc.v !== OCR_QUALITY_ARTIFACT_VERSION) {
      answer.incompatible.push({ ark: doc.ark, v: doc.v })
      continue
    }
    const parsed = workerDocOcrQualitySchema.safeParse(doc)
    if (parsed.success) answer.documents.push(parsed.data)
    else answer.broken.push({ ark: doc.ark, message: z.prettifyError(parsed.error) })
  }
  return { ok: true, answer }
}

// ---------------------------------------------------------------------------
// Typed failures of a sync call — the drainer (lib/documents/ocr-sync.ts)
// treats them differently, so they must never be told apart by message.
// ---------------------------------------------------------------------------

/**
 * The worker could not be asked: transport error, timeout, a 5xx, or a 404
 * from a worker older than the endpoint, a body that is not JSON. Says nothing
 * about any document — see lib/documents/ocr-sync.ts for how an ARK can still
 * earn an outage strike (alone, with a control).
 */
export class OcrSyncUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OcrSyncUnavailableError"
  }
}

/** Who a contract break is about: the whole exchange, or named ARKs of the batch. */
export const OCR_SYNC_FAULT_SCOPE = {
  /** The exchange itself breaks the contract (401/403/413, an envelope that
   *  does not parse, an answer that answers nothing asked): no ARK is at fault. */
  EXCHANGE: "exchange",
  /** Named ARKs of the batch break it (a 400 naming `arks[i]`, ARKs left
   *  unanswered in an otherwise answered batch). */
  ARKS: "arks",
} as const
export type OcrSyncFaultScope = (typeof OCR_SYNC_FAULT_SCOPE)[keyof typeof OCR_SYNC_FAULT_SCOPE]

/**
 * The worker answered, but the answer breaks the contract. The scope decides
 * what the drainer does (lib/documents/ocr-sync.ts):
 *   - EXCHANGE → the sync itself pauses (backoff) and resumes on its own when
 *     the worker answers validly again; no ARK is penalised;
 *   - ARKS → the named `culprits` are rejected (backoff, then quarantine) and
 *     the rest of the batch is asked again.
 */
export class OcrSyncContractError extends Error {
  readonly scope: OcrSyncFaultScope
  readonly culprits: string[]
  constructor(
    message: string,
    fault: { scope: OcrSyncFaultScope; culprits: string[] },
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "OcrSyncContractError"
    this.scope = fault.scope
    this.culprits = fault.culprits
  }
}
