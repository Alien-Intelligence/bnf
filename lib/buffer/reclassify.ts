// lib/buffer/reclassify.ts
// Boot-time reclassifier for buffer rows written below BUFFER_CLASSIFIER_VERSION.
//
// 0.18.1 stored each hit's raw dc:type label in `docType` (`text`, `Texte`,
// `image fixe`, `Monographie imprimée`, …: 25 distinct values over 86 765 prod
// rows), MARC language codes verbatim, no record kind, and nothing at all for
// the 17 422 rows `buffer_add` staged by ARK alone. This pass rewrites them
// into the v2 vocabulary once, with the same rules the staging tools now apply
// (lib/buffer/classify.ts), so the mapping has ONE source in TypeScript rather
// than a second copy in migration SQL (Decision 12 of the Track E plan).
//
// Idempotent by construction: each row is stamped with the current version and
// the pass only reads rows below it, so a finished run costs one empty query.
// Bumping BUFFER_CLASSIFIER_VERSION re-runs it over every row. Bounded (§14):
// a run stops at BUFFER_RECLASSIFY_MAX_MS; it runs at boot and again every
// BUFFER_RECLASSIFY_SWEEP_INTERVAL_MS from instrumentation.ts, so a run that
// stopped early or failed resumes instead of leaving rows at version 0 until
// the next restart. Serving never waits on it.
import "server-only"

import { BUFFER_CLASSIFIER_VERSION, BUFFER_RECLASSIFY_BATCH_SIZE, BUFFER_RECLASSIFY_MAX_MS } from "@/lib/constants"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BufferQueries, type LegacyBufferItem } from "@/models/buffer/queries"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "@/models/buffer/schema"
import { DocumentQueries } from "@/models/documents/queries"
import { bufferMetadataFromDocument, classifyLegacyRow, type ResolvedDocumentFields } from "./classify"

function log(msg: string): void {
  console.log(`[buffer-reclassify] ${msg}`)
}

/** The resolved same-project Documents for the bare rows of one batch, keyed
 *  by `projectId ark`. One query per batch, bounded by the batch size. */
async function resolvedDocumentsFor(bare: LegacyBufferItem[]): Promise<Map<string, ResolvedDocumentFields>> {
  const arksByProject = new Map<string, string[]>()
  for (const r of bare) {
    const list = arksByProject.get(r.projectId)
    if (list) list.push(r.ark)
    else arksByProject.set(r.projectId, [r.ark])
  }
  const docs = await DocumentQueries.resolvedAmong(arksByProject)
  return new Map(docs.map((d) => [`${d.projectId} ${d.ark}`, d]))
}

/** The v1 column values for one legacy row. */
function v1Data(
  row: LegacyBufferItem,
  doc: ResolvedDocumentFields | undefined,
  unknownLabels: Map<string, number>,
): Prisma.BufferItemUpdateManyMutationInput {
  const countUnknown = (label: string) => unknownLabels.set(label, (unknownLabels.get(label) ?? 0) + 1)
  const classified = classifyLegacyRow(row)
  if (classified.unknownLabel !== null) countUnknown(classified.unknownLabel)
  const data: Prisma.BufferItemUpdateManyMutationInput = {
    docTypeRaw: classified.docTypeRaw,
    docType: classified.docType,
    lang: classified.lang,
    arkKind: classified.arkKind,
    classifierVersion: BUFFER_CLASSIFIER_VERSION,
  }
  if (row.title !== null) return data

  // A bare row (staged by ARK only). A resolved Document of the same project
  // holds its metadata already — copy all of it (raw label, links, year range
  // included) by the enricher's rules, no BnF call.
  if (doc !== undefined) {
    return {
      ...data,
      ...bufferMetadataFromDocument(doc, countUnknown),
      enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED,
    }
  }
  // Still curated → queue it for the enrichment drain (lib/buffer/enricher.ts).
  // Committed or discarded bare rows are not curated anymore: spending BnF
  // quota on them would be waste, so they stay unenriched.
  if (row.status === BUFFER_STATUS.CANDIDATE) return { ...data, enrichStatus: BUFFER_ENRICH_STATUS.PENDING }
  return data
}

/**
 * Rewrite the buffer rows below BUFFER_CLASSIFIER_VERSION, in id order, one
 * transaction per batch, until none is left or `maxMs` has elapsed. Returns
 * how many rows changed and whether the run reached the end.
 */
export async function reclassifyBufferItems(
  opts: { maxMs?: number } = {},
): Promise<{ updated: number; complete: boolean }> {
  const deadline = Date.now() + (opts.maxMs ?? BUFFER_RECLASSIFY_MAX_MS)
  let updated = 0
  let cursor: string | null = null
  let complete = false
  const unknownLabels = new Map<string, number>()

  while (Date.now() < deadline) {
    const rows = await BufferQueries.legacyBatch(BUFFER_CLASSIFIER_VERSION, cursor, BUFFER_RECLASSIFY_BATCH_SIZE)
    if (rows.length === 0) {
      complete = true
      break
    }
    cursor = rows[rows.length - 1].id
    const docs = await resolvedDocumentsFor(rows.filter((r) => r.title === null))
    updated += await BufferQueries.applyReclassification(
      BUFFER_CLASSIFIER_VERSION,
      rows.map((r) => ({ id: r.id, data: v1Data(r, docs.get(`${r.projectId} ${r.ark}`), unknownLabels) })),
    )
    if (rows.length < BUFFER_RECLASSIFY_BATCH_SIZE) {
      complete = true
      break
    }
  }

  for (const [label, count] of unknownLabels) {
    console.warn(`[vocab] unknown dc:type "${label}" (${count} buffer row(s)) → other`)
  }
  log(`updated=${updated}${complete ? "" : " — stopped at its time ceiling, the next sweep resumes"}`)
  return { updated, complete }
}
