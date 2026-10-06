// lib/validation/ark.ts
// THE validation of a BnF ARK identifier — one definition shared by every
// model's types.ts (corpus, buffer, documents) and the agent tools. ARKs are
// opaque: validated, never constructed, never mutated (playbook/mcp-client.md).
// Pure Zod, client-safe.

import { z } from "zod"

/** ark:/<NAAN>/<name>: NAAN digits, name alphanumeric. Example: ark:/12148/bpt6k2839841 */
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "ARK invalide")
