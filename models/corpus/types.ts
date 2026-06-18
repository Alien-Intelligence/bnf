// models/corpus/types.ts
// Zod schemas for corpus API request validation and their inferred types.
// These are what route handlers validate against and what client hooks import.
//
// DB-derived shapes (CorpusSnapshot, DocumentRow, CorpusDiff) live in
// schema.ts, not here — per playbook/models.md.

import { z } from "zod"

// ---------------------------------------------------------------------------
// ARK validation
// ---------------------------------------------------------------------------

/**
 * Validates a BnF ARK identifier.
 * Format: ark:/<NAAN>/<name> where <NAAN> is digits and <name> is
 * alphanumeric. ARKs are opaque — never constructed, never mutated.
 * Example: ark:/12148/bpt6k2839841
 */
export const arkSchema = z
  .string()
  .regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

// ---------------------------------------------------------------------------
// Corpus mutation inputs
// ---------------------------------------------------------------------------

export const addToCorpusSchema = z.object({
  /** The ARKs to add. Max 5000 per call (bulk add via agent, not API spam). */
  arks: z.array(arkSchema).min(1).max(5_000),
  /** Human-readable reason for this mutation (logged as version note). */
  reason: z.string().trim().min(1).max(300),
})

export type AddToCorpusInput = z.infer<typeof addToCorpusSchema>

export const removeFromCorpusSchema = z.object({
  /** The ARKs to remove. */
  arks: z.array(arkSchema).min(1).max(5_000),
  /** Human-readable reason for this mutation. */
  reason: z.string().trim().min(1).max(300),
})

export type RemoveFromCorpusInput = z.infer<typeof removeFromCorpusSchema>

// ---------------------------------------------------------------------------
// Diff query params
// ---------------------------------------------------------------------------

export const corpusDiffQuerySchema = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
})

export type CorpusDiffQuery = z.infer<typeof corpusDiffQuerySchema>
