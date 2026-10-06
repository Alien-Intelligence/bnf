// lib/documents/canonical-lang.ts
// Boot pass: rewrite every stored Document.lang into canonicalLang's form
// (lib/mcp/vocab.ts) — the same function the normaliser applies to new
// records, so old and new rows carry one vocabulary and `lang: ["de"]` finds
// the German documents whatever wrote them.
//
// It completes the hand-written UPDATE of migration
// 20261002084519_buffer_item_metadata_v2, which copied only the MARC codes:
// uppercase codes (`DEU`), language names (`allemand`, `german`, `latin`…) and
// the lowercasing of unknown codes were left out. TypeScript is the one source
// of the mapping; this pass applies it to what the SQL did not cover.
//
// Idempotent and cheap: it reads the distinct stored values (a few dozen) and
// rewrites only those canonicalLang changes, so a second run updates nothing.
import "server-only"

import { canonicalLang } from "@/lib/mcp/vocab"
import { DocumentQueries } from "@/models/documents/queries"

export async function canonicalizeDocumentLangs(): Promise<{ updated: number }> {
  let updated = 0
  for (const stored of await DocumentQueries.distinctLangs()) {
    const canonical = canonicalLang(stored)
    if (canonical === stored) continue
    updated += await DocumentQueries.replaceLang(stored, canonical)
  }
  console.log(`[document-lang] canonicalised ${updated} document(s)`)
  return { updated }
}
