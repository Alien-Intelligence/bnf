// models/documents/types.ts
// Zod schemas for document API request/query validation.
//
// The full document detail endpoint and its query parameters (filters, sort,
// pagination) land in a later slice. This file is a placeholder that will be
// extended then. It is present now so the five-file model structure is complete
// from slice 1 (playbook/models.md: "five files per directory, no exceptions").

import { z } from "zod"

/**
 * Query params for the document detail endpoint.
 * Placeholder — extended in slice 2 when the detail route ships.
 */
export const documentDetailQuerySchema = z.object({
  // No query params yet; shape extended in slice 2.
})

export type DocumentDetailQuery = z.infer<typeof documentDetailQuerySchema>
