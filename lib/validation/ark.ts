// lib/validation/ark.ts
// THE validation of a BnF ARK identifier — one definition shared by every
// model's types.ts (corpus, buffer, documents) and the agent tools. ARKs are
// opaque: validated, never constructed, never mutated (playbook/mcp-client.md).
// Pure Zod, client-safe.

import { z } from "zod"

/** ark:/<NAAN>/<name>: NAAN digits, name alphanumeric. Example: ark:/12148/bpt6k2839841 */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")

/** The NAAN every BnF-held ARK (Gallica and catalogue) carries. Defined once for the app; the worker has its own (worker-v2/src/bnf/parse.ts), a separate package. */
const BNF_NAAN = "12148"

/**
 * The full ARK of a BnF record given its bare local id, or the ARK itself when
 * it is already full (left to the caller's own checks, e.g. a temp-work URI).
 *
 * THE sanctioned ARK constructor (playbook/mcp-client.md, "The one boundary
 * exception"). It exists because the BnF MCP wire contract sends bare ids
 * (`bpt6k2839841`, not `ark:/12148/bpt6k2839841`) and so do the parsers and
 * every cached BnfRecord payload keyed by them; removing the construction needs
 * an mcp-bnf contract change. mcp-client.md's rule ("an ARK is an opaque
 * string") is satisfied at this boundary: the id is lifted into the opaque
 * full form here, once, and from then on the ARK is passed as an opaque token.
 * A built ARK must pass `arkSchema`, so a junk id is refused (null) rather than
 * becoming a plausible identity. Do not call it on anything but a value that
 * crossed that wire boundary.
 */
export function fullBnfArk(idOrArk: string): string | null {
  if (idOrArk.startsWith("ark:/")) return idOrArk
  const full = `ark:/${BNF_NAAN}/${idOrArk}`
  return arkSchema.safeParse(full).success ? full : null
}
