/**
 * Backfill Document.docType + Document.subtype (+ the fresh rawMetadata) for
 * Gallica documents that were resolved BEFORE the typedoc classification fix,
 * and clear the fascicule page counts that came from OAI's collection-level
 * "Nombre total de vues".
 *
 * Why: the OAI-PMH <dc:type> values are generic physical-form labels ("texte",
 * "publication en série imprimée") that collapse periodicals, monographs, etc.
 * to "book". The authoritative discriminator is the record header <setSpec>
 * "gallica:typedoc:<cat>:<sub>", which the resolver reads (→ docType) and
 * splits (→ subtype). See lib/mcp/vocab.ts + lib/bnf/oai-record.ts.
 *
 * Source of the record, per ARK:
 *   • the global BnfRecord cache (models/bnf-records), keyed by ARK, no TTL —
 *     a hit costs zero BnF calls;
 *   • on a miss, `BnfDirectClient.resolveArks(arks, { mode: "staging" })`: the
 *     OAI record only, NEVER the IIIF manifest. The fresh record is written to
 *     the cache, so the next run (or any project re-adding the ARK) is free.
 *   • `--refresh` skips the cache read, re-fetches, and overwrites the cache
 *     entry — the only way an entry ever changes.
 *
 * What it writes (`--apply`), per Document row:
 *   • docType + subtype, from normalizing the record;
 *   • rawMetadata, whenever the record was FETCHED (even if nothing else
 *     changed, so the typedoc is on the row for good) or the row changed. The
 *     `ocr_source` / `pages_source` provenance of the row is carried over; a
 *     row that carries no OAI typedoc is a legacy manifest-resolved row and is
 *     stamped "manifest" for both;
 *   • `pages = null`, only when the page rule (gallicaPageCount, applied by
 *     normalize) says null AND the row's pages came from OAI.
 * It NEVER touches manifest-derived `pages` or `ocr_available`: this script
 * has no manifest verdict, and OAI silence proves nothing about a text layer.
 *
 * Pacing: the OAI record goes through the broker's `external` bucket (120 rpm,
 * burst 20), shared with corpus adds and the buffer enricher. The default of
 * batch 10 / delay 2000ms asks for at most ~300 records a minute, which
 * exceeds that bucket on purpose: the resolver retries the 429s it sheds, and
 * going slower only lengthens the run. Lower the pressure on a busy broker
 * with a larger --delay or a smaller --batch.
 *
 * Resumable: an ARK whose record is cached costs no BnF call, and a row that
 * is already correct is not rewritten, so a failed or interrupted run is
 * simply re-run. Combined with `--limit` (ARKs FETCHED this run), the whole
 * corpus can be backfilled in safe chunks.
 *
 * Exit status: nonzero when any ARK failed for a reason other than "not on
 * Gallica" (rate-limited, transport, parse), or when the run itself threw.
 *
 *   npm run fix:doc-types -- --limit 30      # cheap preview of 30 fetches (dry)
 *   npm run fix:doc-types -- --apply         # write (paced; resumable)
 *   npm run fix:doc-types -- --apply --limit 500 [--batch 10] [--delay 2000]
 *   npm run fix:doc-types -- --apply --refresh   # re-fetch and overwrite the cache
 */
import { parseArgs } from "node:util"
import {
  OCR_SOURCE,
  PAGES_SOURCE,
  RAW_METADATA_KEY,
  RESOLVE_MODE,
  type BnfMcpDocumentDetail,
  type BnfMcpResolveError,
  type BnfMcpResolveResult,
} from "@/lib/bnf/types"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import { normalizeDocument } from "@/lib/mcp/normalize"
import { DOCUMENT_RESOLVE_STATUS, DOCUMENT_SOURCE } from "@/models/documents/schema"

/** Default ARKs per resolver call, and the pause between two batches that called BnF. */
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_BATCH_DELAY_MS = 2000

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FixDocTypesOptions {
  apply: boolean
  refresh: boolean
  /** Maximum number of ARKs FETCHED from BnF this run; cache hits are free. */
  limit: number
  batch: number
  delayMs: number
}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} expects a positive integer, got "${raw}"`)
  }
  return n
}

/** Parse the CLI flags strictly: an unknown flag or a bad number is an error, never a silent default. */
export function parseOptions(argv: string[]): FixDocTypesOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      apply: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      limit: { type: "string" },
      batch: { type: "string" },
      delay: { type: "string" },
    },
  })
  return {
    apply: values.apply,
    refresh: values.refresh,
    limit: values.limit === undefined ? Infinity : positiveInt("--limit", values.limit),
    batch: values.batch === undefined ? DEFAULT_BATCH_SIZE : positiveInt("--batch", values.batch),
    delayMs: values.delay === undefined ? DEFAULT_BATCH_DELAY_MS : positiveInt("--delay", values.delay),
  }
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** One resolved Gallica Document row, as the backfill sees it. */
export interface DocRow {
  projectId: string
  ark: string
  docType: string | null
  subtype: string | null
  pages: number | null
  rawMetadata: Prisma.JsonValue | null
}

/** The columns the backfill may write. `pages` is only ever set to null. */
export interface RowUpdate {
  docType: string
  subtype: string | null
  rawMetadata: Prisma.InputJsonValue
  pages?: null
}

/** Document rows: read all resolved Gallica rows, write one row's update. */
export interface DocumentStore {
  listResolvedGallicaRows(): Promise<DocRow[]>
  updateRow(key: { projectId: string; ark: string }, data: RowUpdate): Promise<void>
}

/** The global per-ARK BnF record cache. */
export interface RecordCache {
  /** Cached payloads among `arks`, keyed by ARK. Absent ARKs are misses. */
  found(arks: string[]): Promise<Map<string, BnfMcpDocumentDetail>>
  /** Insert or overwrite the cache entries for freshly fetched records. */
  write(results: BnfMcpResolveResult[]): Promise<void>
}

/** The resolver: OAI-only in `staging` mode, never the manifest. */
export interface OaiResolver {
  resolveArks(
    arks: string[],
    opts: { mode: typeof RESOLVE_MODE.STAGING },
  ): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>>
}

export interface FixDocTypesDeps {
  store: DocumentStore
  cache: RecordCache
  resolver: OaiResolver
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

export interface FixDocTypesFailure {
  ark: string
  reason: string
}

export interface FixDocTypesSummary {
  /** Unique ARKs scanned. */
  arks: number
  /** ARKs whose record came from BnF this run. */
  fetched: number
  /** ARKs whose record came from the cache. */
  cacheHits: number
  /** Rows that changed (or would change in a dry run). */
  changedRows: number
  unchangedRows: number
  /** Of the changed rows, how many have their OAI-derived pages cleared. */
  pagesCleared: number
  /** Rows whose rawMetadata is written solely because the record was fetched. */
  rawMetadataOnlyRows: number
  notFound: number
  /** Resolved but unusable (no title): treated as a dead ARK. */
  unusable: number
  /** Everything that failed for a reason other than "not on Gallica". */
  failures: FixDocTypesFailure[]
  rateLimited: number
  /** ARKs left unfetched because of --limit. */
  deferred: number
  transitions: Map<string, number>
}

function isJsonObject(raw: Prisma.JsonValue | null): raw is Prisma.JsonObject {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
}

/** True when the stored rawMetadata carries the OAI typedoc (SQL: `raw_metadata ? 'gallica_typedoc'`). */
function hasOaiTypedoc(raw: Prisma.JsonValue | null): boolean {
  return isJsonObject(raw) && Object.hasOwn(raw, RAW_METADATA_KEY.GALLICA_TYPEDOC)
}

/**
 * True when the row's `pages` came from OAI: the row was resolved from an OAI
 * record (it carries the typedoc) and its provenance does not say the manifest
 * decided the page count.
 */
function pagesCameFromOai(row: DocRow): boolean {
  if (!hasOaiTypedoc(row.rawMetadata)) return false
  const source = isJsonObject(row.rawMetadata) ? row.rawMetadata[RAW_METADATA_KEY.PAGES_SOURCE] : undefined
  return source !== PAGES_SOURCE.MANIFEST
}

/**
 * The rawMetadata to persist: the fresh OAI payload, with the row's existing
 * ocr/pages provenance carried over. Without the carry-over a manifest-derived
 * row would be relabelled as OAI-derived and a later run would clear pages the
 * manifest had decided. A legacy row (no OAI typedoc) was resolved from the
 * manifest, so it is stamped so.
 */
function mergedRawMetadata(row: DocRow, fresh: Prisma.InputJsonObject): Prisma.InputJsonValue {
  const stored = isJsonObject(row.rawMetadata) ? row.rawMetadata : null
  const legacy = !hasOaiTypedoc(row.rawMetadata)
  const ocrSource = legacy ? OCR_SOURCE.MANIFEST : stored?.[RAW_METADATA_KEY.OCR_SOURCE]
  const pagesSource = legacy ? PAGES_SOURCE.MANIFEST : stored?.[RAW_METADATA_KEY.PAGES_SOURCE]
  return {
    ...fresh,
    ...(ocrSource === undefined ? {} : { [RAW_METADATA_KEY.OCR_SOURCE]: ocrSource }),
    ...(pagesSource === undefined ? {} : { [RAW_METADATA_KEY.PAGES_SOURCE]: pagesSource }),
  }
}

function transitionKey(
  from: { docType: string | null; subtype: string | null },
  to: { docType: string; subtype: string | null },
): string {
  return `${from.docType ?? "∅"}/${from.subtype ?? "∅"} → ${to.docType}/${to.subtype ?? "∅"}`
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Run the backfill. Pure over its dependencies: the caller injects the row
 * store, the record cache, the resolver and the clock, so the whole decision
 * logic is unit-testable without a database or the network.
 *
 * Dry run (`apply: false`) reads and fetches but writes nothing: no row, no
 * cache entry.
 */
export async function runFixDocTypes(
  opts: FixDocTypesOptions,
  deps: FixDocTypesDeps,
): Promise<FixDocTypesSummary> {
  const { store, cache, resolver, sleep, log } = deps

  const rows = await store.listResolvedGallicaRows()
  const rowsByArk = new Map<string, DocRow[]>()
  for (const row of rows) {
    const group = rowsByArk.get(row.ark)
    if (group === undefined) rowsByArk.set(row.ark, [row])
    else group.push(row)
  }
  const arks = [...rowsByArk.keys()]

  const summary: FixDocTypesSummary = {
    arks: arks.length,
    fetched: 0,
    cacheHits: 0,
    changedRows: 0,
    unchangedRows: 0,
    pagesCleared: 0,
    rawMetadataOnlyRows: 0,
    notFound: 0,
    unusable: 0,
    failures: [],
    rateLimited: 0,
    deferred: 0,
    transitions: new Map(),
  }
  log(
    `scanned ${rows.length} row(s) · ${arks.length} unique ARK(s)` +
      (opts.refresh ? " · --refresh: cache reads skipped" : ""),
  )

  /** Reconcile every row of one ARK against its record. */
  const reconcile = async (ark: string, record: BnfMcpDocumentDetail, fetched: boolean) => {
    const norm = normalizeDocument(record)
    if (norm === null) {
      summary.unusable++ // resolved but no usable title → treat as a dead ARK
      return
    }
    const target = { docType: norm.docType, subtype: norm.subtype ?? null }
    const fresh = norm.rawMetadata as Prisma.InputJsonObject

    for (const row of rowsByArk.get(ark) ?? []) {
      const pagesCleared = norm.pages === null && row.pages !== null && pagesCameFromOai(row)
      const classChanged = row.docType !== target.docType || row.subtype !== target.subtype
      if (!classChanged && !pagesCleared && !fetched) {
        summary.unchangedRows++
        continue
      }

      if (classChanged || pagesCleared) {
        summary.changedRows++
        const key = transitionKey(row, target)
        summary.transitions.set(key, (summary.transitions.get(key) ?? 0) + 1)
        if (pagesCleared) summary.pagesCleared++
      } else {
        summary.unchangedRows++
        summary.rawMetadataOnlyRows++
      }

      if (opts.apply) {
        const data: RowUpdate = {
          ...target,
          rawMetadata: mergedRawMetadata(row, fresh),
          ...(pagesCleared ? { pages: null } : {}),
        }
        await store.updateRow({ projectId: row.projectId, ark }, data)
      }
    }
  }

  const failed = (ark: string, error: unknown) => {
    if (error instanceof BnfMcpNotFoundError) {
      summary.notFound++
      return
    }
    if (error instanceof BnfMcpRateLimitError) summary.rateLimited++
    summary.failures.push({ ark, reason: describe(error) })
  }

  for (let i = 0; i < arks.length; i += opts.batch) {
    const slice = arks.slice(i, i + opts.batch)

    const hits = opts.refresh ? new Map<string, BnfMcpDocumentDetail>() : await cache.found(slice)
    for (const ark of slice) {
      const hit = hits.get(ark)
      if (hit !== undefined) {
        summary.cacheHits++
        await reconcile(ark, hit, false)
      }
    }

    const allMisses = slice.filter((ark) => !hits.has(ark))
    const budget = Math.max(0, opts.limit - summary.fetched)
    const misses = allMisses.slice(0, budget)
    summary.deferred += allMisses.length - misses.length

    if (misses.length > 0) {
      const results = await resolver.resolveArks(misses, { mode: RESOLVE_MODE.STAGING })
      const records: BnfMcpResolveResult[] = []
      for (const res of results) {
        if (res.ok) records.push(res)
        else failed(res.ark, res.error)
      }
      summary.fetched += misses.length
      if (opts.apply && records.length > 0) await cache.write(records)
      for (const record of records) await reconcile(record.ark, record.document, true)
    }

    log(`  processed ${Math.min(i + opts.batch, arks.length)}/${arks.length} ARK(s)…`)
    // Pace only when BnF was actually called, and not after the last batch.
    if (misses.length > 0 && i + opts.batch < arks.length) await sleep(opts.delayMs)
  }

  return summary
}

/** The human report. Returns true when the run is clean (no failures). */
export function reportSummary(
  s: FixDocTypesSummary,
  opts: FixDocTypesOptions,
  log: (line: string) => void,
): boolean {
  log("\n── transitions ──")
  for (const [k, n] of [...s.transitions.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${n.toString().padStart(5)}  ${k}`)
  }
  log(
    `\n${s.changedRows} row(s) ${opts.apply ? "updated" : "would change"} ` +
      `(${s.pagesCleared} with OAI-derived pages cleared), ${s.unchangedRows} already correct` +
      (s.rawMetadataOnlyRows > 0
        ? ` (${s.rawMetadataOnlyRows} of those ${opts.apply ? "had" : "would have"} only their rawMetadata refreshed)`
        : "") +
      ".",
  )
  log(`records: ${s.fetched} fetched from BnF · ${s.cacheHits} from the cache`)
  if (s.notFound + s.unusable > 0) {
    log(`skipped: ${s.notFound} not-on-Gallica (no record) · ${s.unusable} without a usable title`)
  }
  if (s.deferred > 0) {
    log(`${s.deferred} ARK(s) not fetched because of --limit — re-run to continue (fetched ARKs are cached).`)
  }
  if (s.failures.length > 0) {
    log(`FAILED: ${s.failures.length} ARK(s) could not be resolved:`)
    for (const f of s.failures) log(`  ${f.ark}  ${f.reason}`)
    if (s.rateLimited > 0) {
      log("  ⚠ broker is shedding — lower the rate: re-run with a larger --delay or a smaller --batch.")
    }
  }
  if (!opts.apply && s.changedRows + s.rawMetadataOnlyRows > 0) {
    log("Re-run with `-- --apply` to write these changes.")
  }
  return s.failures.length === 0
}

// ---------------------------------------------------------------------------
// Wiring (database, cache, BnF) and entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2))
  console.log(
    `fix-doc-types: ${opts.apply ? "APPLY (writing)" : "DRY RUN (no writes — pass --apply to write)"}` +
      `  ·  limit=${opts.limit === Infinity ? "none" : opts.limit} batch=${opts.batch} ` +
      `delay=${opts.delayMs}ms${opts.refresh ? " refresh" : ""}`,
  )

  // Loaded here, not at the top: the pure core above is imported by the unit
  // test, which must not open a database connection.
  const { prisma } = await import("@/lib/db")
  const { BnfDirectClient } = await import("@/lib/bnf/direct")
  const { BnfRecordService } = await import("@/models/bnf-records/service")

  try {
    const summary = await runFixDocTypes(opts, {
      store: {
        listResolvedGallicaRows: () =>
          prisma.document.findMany({
            where: {
              source: DOCUMENT_SOURCE.GALLICA,
              resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
            },
            select: {
              projectId: true,
              ark: true,
              docType: true,
              subtype: true,
              pages: true,
              rawMetadata: true,
            },
          }),
        updateRow: async ({ projectId, ark }, data) => {
          await prisma.document.updateMany({ where: { projectId, ark, source: DOCUMENT_SOURCE.GALLICA }, data })
        },
      },
      cache: {
        found: (arks) => BnfRecordService.foundAmong(arks),
        write: (results) => BnfRecordService.upsertMany(results),
      },
      resolver: new BnfDirectClient(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    })
    return reportSummary(summary, opts, (line) => console.log(line)) ? 0 : 1
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error("fix-doc-types failed:", error)
      process.exitCode = 1
    },
  )
}
