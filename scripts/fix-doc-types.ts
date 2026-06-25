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
 * Strategy (the BnF credential is shared and rate-capped — never re-fetch what
 * we already hold, and stay well under the cap so we don't starve the worker):
 *   • If a row's stored rawMetadata already carries `gallica_typedoc` (i.e. it
 *     was resolved AFTER the fix), reclassify it LOCALLY — no network.
 *   • Otherwise re-fetch the OAI through the broker (the official egress tunnel)
 *     in small PACED batches, which yields a corrected docType/subtype AND a
 *     rawMetadata that carries `gallica_typedoc` for next time.
 *
 * Resumable: with `--apply`, each fetched ARK is rewritten with its typedoc, so
 * a later run reclassifies it locally instead of re-fetching. Combined with
 * `--limit`, the whole corpus can be backfilled in safe chunks across runs.
 *
 * Unique-ARK deduped; Gallica-only (typedoc is a Gallica concept).
 *
 *   npm run fix:doc-types -- --limit 30      # cheap preview of 30 ARKs (dry)
 *   npm run fix:doc-types -- --apply         # write (paced; resumable)
 *   npm run fix:doc-types -- --apply --limit 500 [--batch 10] [--delay 2000]
 */
import { BnfDirectClient } from "@/lib/bnf/direct"
import { prisma } from "@/lib/db"
import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import { normalizeDocument } from "@/lib/mcp/normalize"

const APPLY = process.argv.includes("--apply")

/** Read a numeric CLI flag (`--name N`), or a default. */
function numArg(name: string, dflt: number): number {
  const i = process.argv.indexOf(name)
  if (i === -1 || i + 1 >= process.argv.length) return dflt
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : dflt
}

// Pacing: re-fetch in small batches with a pause between them so we stay under
// the broker's shared ~300/min cap and leave headroom for the ingest worker.
// At batch 10 / delay 2000ms the ceiling is ~300/min; the broker sheds (HTTP
// 429) above that, so going faster just wastes retries. Tune with --batch/--delay.
const LIMIT = numArg("--limit", Infinity)
const BATCH = numArg("--batch", 10)
const DELAY_MS = numArg("--delay", 2000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  console.log(
    `fix-doc-types: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes — pass --apply to write)"}` +
      `  ·  limit=${LIMIT === Infinity ? "none" : LIMIT} batch=${BATCH} delay=${DELAY_MS}ms`,
  )

  // All resolved Gallica rows. One ARK can span many projects.
  const rows = await prisma.document.findMany({
    where: { source: "gallica", resolveStatus: "resolved" },
    select: { ark: true, docType: true, subtype: true, rawMetadata: true },
  })

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

  // Partition: reclassify locally (rawMetadata already carries the typedoc) vs.
  // must re-fetch the OAI through the broker.
  const local: string[] = []
  let needFetch: string[] = []
  for (const [ark, rep] of byArk) {
    if (storedTypedoc(rep.rawMetadata) !== null) local.push(ark)
    else needFetch.push(ark)
  }
  const fetchTotal = needFetch.length
  if (needFetch.length > LIMIT) needFetch = needFetch.slice(0, LIMIT)

  console.log(
    `scanned ${rows.length} row(s) · ${byArk.size} unique ARK(s) · ` +
      `reclassify locally: ${local.length} · re-fetch needed: ${fetchTotal}` +
      (needFetch.length < fetchTotal ? ` (this run: ${needFetch.length})` : ""),
  )

  const targets: Reclass[] = []

  // ── Local path — re-run the normalizer over the stored payload. ────────────
  for (const ark of local) {
    const rep = byArk.get(ark)!
    const norm = normalizeDocument(rep.rawMetadata as BnfMcpDocumentDetail)
    if (norm === null) continue
    targets.push({ ark, docType: norm.docType, subtype: norm.subtype ?? null })
  }

  // ── Fetch path — re-resolve through the broker, PACED. ─────────────────────
  let notFound = 0
  let rateLimited = 0
  let otherErr = 0
  if (needFetch.length > 0) {
    const client = new BnfDirectClient()
    for (let i = 0; i < needFetch.length; i += BATCH) {
      const slice = needFetch.slice(i, i + BATCH)
      const results = await client.resolveArks(slice)
      for (const res of results) {
        if (!res.ok) {
          if (res.error instanceof BnfMcpNotFoundError) notFound++
          else if (res.error instanceof BnfMcpRateLimitError) rateLimited++
          else otherErr++
          continue
        }
        const norm = normalizeDocument(res.document)
        if (norm === null) {
          notFound++ // resolved but no usable title → treat as a dead ARK
          continue
        }
        targets.push({
          ark: res.ark,
          docType: norm.docType,
          subtype: norm.subtype ?? null,
          rawMetadata: norm.rawMetadata,
        })
      }
      const done = Math.min(i + BATCH, needFetch.length)
      process.stdout.write(`\r  fetched ${done}/${needFetch.length}…`)
      if (done < needFetch.length) await sleep(DELAY_MS)
    }
    process.stdout.write("\n")
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
    transitions.set(transitionKey(rep, t), (transitions.get(transitionKey(rep, t)) ?? 0) + 1)

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
  if (notFound + rateLimited + otherErr > 0) {
    console.log(
      `skipped: ${notFound} not-on-Gallica (no record) · ${rateLimited} rate-limited · ${otherErr} other error`,
    )
    if (rateLimited > 0) {
      console.log(
        "  ⚠ broker is shedding — lower the rate: re-run with a larger --delay or smaller --batch.",
      )
    }
  }
  if (!APPLY && changed > 0) console.log("Re-run with `-- --apply` to write these changes.")
  if (APPLY && fetchTotal > needFetch.length) {
    console.log(
      `${fetchTotal - needFetch.length} ARK(s) still need fetching — re-run to continue (already-done ARKs reclassify locally).`,
    )
  }

  await prisma.$disconnect()
})()
