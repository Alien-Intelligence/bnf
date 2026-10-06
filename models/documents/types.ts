// models/documents/types.ts
// Zod schemas for document API request/query validation.
//
// Imports zod and the app's one shared ARK schema only (playbook/models.md):
// the worker-v2 OCR-quality wire contract lives with the other cluster
// contracts in lib/cluster/ocr-quality.ts, not here.

import { z } from "zod"

import { arkSchema } from "@/lib/validation/ark"

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
