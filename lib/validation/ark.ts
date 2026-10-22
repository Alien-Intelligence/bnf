// lib/validation/ark.ts
// THE validation of a BnF ARK identifier — one definition shared by every
// model's types.ts (corpus, buffer, documents) and the agent tools. ARKs are
// opaque: validated, never constructed, never mutated (playbook/mcp-client.md).
// Pure Zod, client-safe.

import { z } from "zod"

/** ark:/<NAAN>/<name>: NAAN digits, name alphanumeric. Example: ark:/12148/bpt6k2839841 */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

/** The naan every BnF-held ARK (Gallica and catalogue) carries. */
export const BNF_ARK_PREFIX = "ark:/12148/"

/**
 * The full ARK of a BnF record given its bare local id (the short form the BnF
 * parsers and every cached BnfRecord payload key a record by), or the ARK
 * itself when it is already full (left to the caller's own checks, e.g. a
 * temp-work URI). The single place the BnF naan is restored; a restored ARK
 * must pass `arkSchema`, so a junk id is refused (null) instead of becoming a
 * plausible identity.
 */
export function fullBnfArk(idOrArk: string): string | null {
  if (idOrArk.startsWith("ark:/")) return idOrArk
  const full = `${BNF_ARK_PREFIX}${idOrArk}`
  return arkSchema.safeParse(full).success ? full : null
}
