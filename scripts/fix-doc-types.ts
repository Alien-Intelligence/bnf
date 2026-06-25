/**
 * Backfill Document.docType + Document.subtype for Gallica documents that were
 * resolved BEFORE the typedoc classification fix.
 *
 * Why: the OAI-PMH <dc:type> values are generic physical-form labels ("texte",
 * "publication en série imprimée") that collapse periodicals, monographs, etc.
 * to "book". The authoritative discriminator is the record header <setSpec>
 * "gallica:typedoc:<cat>:<sub>", which the resolver now reads (→ docType) and
 * splits (→ subtype). See lib/mcp/vocab.ts + lib/bnf/direct.ts.
 *
 * Strategy (one BnF call only when unavoidable — the credential is shared and
 * rate-capped, so we never re-fetch what we already hold):
 *   • If a row's stored rawMetadata already carries `gallica_typedoc` (i.e. it
 *     was resolved AFTER the fix), reclassify it LOCALLY — no network.
 *   • Otherwise re-fetch the OAI through the broker (the official egress
 *     tunnel) via BnfDirectClient, which yields a corrected docType/subtype AND
 *     a rawMetadata that carries `gallica_typedoc` for next time.
 *
 * Unique-ARK deduped: the same ARK in N projects is fetched once and all its
 * rows are updated together. Gallica-only (typedoc is a Gallica concept).
 *
 * Dry-run by default — prints what WOULD change. Pass `--apply` to write.
 *
 *   npm run fix:doc-types            # dry run
 *   npm run fix:doc-types -- --apply # write
 */
import { BnfDirectClient } from "@/lib/bnf/direct"
import { prisma } from "@/lib/db"
import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import type { Prisma } from "@/lib/generated/prisma/client"
import { normalizeDocument } from "@/lib/mcp/normalize"

const APPLY = process.argv.includes("--apply")

/** Per-ARK target classification computed from local data or a fresh fetch. */
interface Reclass {
  ark: string
  docType: string
  subtype: string | null
  /** Fresh payload to persist (fetched path); undefined on the local path. */
  rawMetadata?: unknown
}

/** Read `gallica_typedoc` off a stored rawMetadata JSON, or null. */
function storedTypedoc(raw: Prisma.JsonValue | null): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const v = (raw as Record<string, unknown>)["gallica_typedoc"]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

function transitionKey(
  from: { docType: string | null; subtype: string | null },
  to: { docType: string; subtype: string | null },
): string {
  return `${from.docType ?? "∅"}/${from.subtype ?? "∅"} → ${to.docType}/${to.subtype ?? "∅"}`
}

void (async () => {
  console.log(`fix-doc-types: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes — pass --apply to write)"}`)

  // All resolved Gallica rows. One ARK can span many projects.
  const rows = await prisma.document.findMany({
    where: { source: "gallica", resolveStatus: "resolved" },
    select: { ark: true, docType: true, subtype: true, rawMetadata: true },
  })
  console.log(`scanned ${rows.length} resolved Gallica document row(s)`)

  // Representative row per ARK (first wins — the update applies to all rows of
  // the ARK, so they converge regardless of which we sample).
  const byArk = new Map<
    string,
    { docType: string | null; subtype: string | null; rawMetadata: Prisma.JsonValue | null }
  >()
  for (const r of rows) {
    if (!byArk.has(r.ark)) {
      byArk.set(r.ark, { docType: r.docType, subtype: r.subtype, rawMetadata: r.rawMetadata })
    }
  }
  console.log(`${byArk.size} unique ARK(s)`)

  // Partition: reclassify locally (rawMetadata already carries the typedoc) vs.
  // must re-fetch the OAI through the broker.
  const local: string[] = []
  const needFetch: string[] = []
  for (const [ark, rep] of byArk) {
    if (storedTypedoc(rep.rawMetadata) !== null) local.push(ark)
    else needFetch.push(ark)
  }
  console.log(`reclassify locally: ${local.length} · re-fetch via broker: ${needFetch.length}`)

  const targets: Reclass[] = []

  // ── Local path — re-run the normalizer over the stored payload. ────────────
  for (const ark of local) {
    const rep = byArk.get(ark)!
    const norm = normalizeDocument(rep.rawMetadata as BnfMcpDocumentDetail)
    if (norm === null) {
      console.warn(`  local skip ${ark}: normalize returned null`)
      continue
    }
    targets.push({ ark, docType: norm.docType, subtype: norm.subtype ?? null })
  }

  // ── Fetch path — re-resolve through the broker, then normalize. ────────────
  if (needFetch.length > 0) {
    const client = new BnfDirectClient()
    const results = await client.resolveArks(needFetch)
    for (const res of results) {
      if (!res.ok) {
        console.warn(`  fetch FAILED ${res.ark}: ${describeError(res.error)}`)
        continue
      }
      const norm = normalizeDocument(res.document)
      if (norm === null) {
        console.warn(`  fetch skip ${res.ark}: normalize returned null`)
        continue
      }
      targets.push({
        ark: res.ark,
        docType: norm.docType,
        subtype: norm.subtype ?? null,
        rawMetadata: norm.rawMetadata,
      })
    }
  }

  // ── Diff + apply. ──────────────────────────────────────────────────────────
  const transitions = new Map<string, number>()
  let changed = 0
  let unchanged = 0

  for (const t of targets) {
    const rep = byArk.get(t.ark)!
    const isChanged = rep.docType !== t.docType || (rep.subtype ?? null) !== t.subtype
    if (!isChanged) {
      unchanged++
      continue
    }
    changed++
    const key = transitionKey(rep, t)
    transitions.set(key, (transitions.get(key) ?? 0) + 1)

    if (APPLY) {
      const data: Prisma.DocumentUpdateManyMutationInput = {
        docType: t.docType,
        subtype: t.subtype,
      }
      // Persist the fresh payload (carries gallica_typedoc) so a future run
      // reclassifies this ARK locally instead of re-fetching it.
      if (t.rawMetadata !== undefined) {
        data.rawMetadata = t.rawMetadata as Prisma.InputJsonValue
      }
      await prisma.document.updateMany({ where: { ark: t.ark, source: "gallica" }, data })
    }
  }

  console.log("\n── transitions ──")
  for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(5)}  ${k}`)
  }
  console.log(
    `\n${changed} ARK(s) ${APPLY ? "updated" : "would change"}, ${unchanged} already correct.`,
  )
  if (!APPLY && changed > 0) {
    console.log("Re-run with `-- --apply` to write these changes.")
  }

  await prisma.$disconnect()
})()

/** Best-effort one-line error description (BnfDirectClient errors are typed). */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
