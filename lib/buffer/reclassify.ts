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
// the pass only reads rows below it, so a restart logs `updated=0`. Bumping
// BUFFER_CLASSIFIER_VERSION re-runs it over every row. It runs once per boot,
// fire-and-forget, from instrumentation.ts — serving never waits on it.
import "server-only"

import { BUFFER_CLASSIFIER_VERSION, BUFFER_RECLASSIFY_BATCH_SIZE } from "@/lib/constants"
import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "@/models/buffer/schema"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { bufferMetadataFromDocument, classifyLegacyRow, type ResolvedDocumentFields } from "./classify"

function log(msg: string): void {
  console.log(`[buffer-reclassify] ${msg}`)
}

const legacyRowSelect = {
  id: true,
  projectId: true,
  ark: true,
  title: true,
  docType: true,
  lang: true,
  originTool: true,
  originQuery: true,
  source: true,
  status: true,
} satisfies Prisma.BufferItemSelect

type LegacyRow = Prisma.BufferItemGetPayload<{ select: typeof legacyRowSelect }>

/**
 * The resolved same-project Documents for the bare rows of one batch, keyed by
 * `projectId ark`. One query per batch, bounded by the batch size.
 */
async function resolvedDocumentsFor(bare: LegacyRow[]): Promise<Map<string, ResolvedDocumentFields>> {
  const out = new Map<string, ResolvedDocumentFields>()
  if (bare.length === 0) return out
  const arksByProject = new Map<string, string[]>()
  for (const r of bare) {
    const list = arksByProject.get(r.projectId)
    if (list) list.push(r.ark)
    else arksByProject.set(r.projectId, [r.ark])
  }
  const docs = await prisma.document.findMany({
    where: {
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
      OR: [...arksByProject].map(([projectId, arks]) => ({ projectId, ark: { in: arks } })),
    },
    select: {
      projectId: true,
      ark: true,
      title: true,
      author: true,
      year: true,
      dateLabel: true,
      docType: true,
      lang: true,
      rawMetadata: true,
    },
  })
  for (const d of docs) out.set(`${d.projectId} ${d.ark}`, d)
  return out
}

/** The v1 column values for one legacy row. */
function v1Data(
  row: LegacyRow,
  doc: ResolvedDocumentFields | undefined,
  unknownLabels: Map<string, number>,
): Prisma.BufferItemUpdateManyMutationInput {
  const classified = classifyLegacyRow(row)
  if (classified.unknownLabel !== null) {
    unknownLabels.set(classified.unknownLabel, (unknownLabels.get(classified.unknownLabel) ?? 0) + 1)
  }
  const data: Prisma.BufferItemUpdateManyMutationInput = {
    docTypeRaw: classified.docTypeRaw,
    docType: classified.docType,
    lang: classified.lang,
    arkKind: classified.arkKind,
    classifierVersion: BUFFER_CLASSIFIER_VERSION,
  }
  if (row.title !== null) return data

  // A bare row (staged by ARK only). A resolved Document of the same project
  // holds its metadata already — copy it, no BnF call.
  if (doc !== undefined) {
    return { ...data, ...bufferMetadataFromDocument(doc), enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED }
  }
  // Still curated → queue it for the enrichment drain (lib/buffer/enricher.ts).
  // Committed or discarded bare rows are not curated anymore: spending BnF
  // quota on them would be waste, so they stay unenriched.
  if (row.status === BUFFER_STATUS.CANDIDATE) return { ...data, enrichStatus: BUFFER_ENRICH_STATUS.PENDING }
  return data
}

/**
 * Rewrite every buffer row below BUFFER_CLASSIFIER_VERSION, in id order, one
 * transaction per batch. Each update is guarded on the version, so a row a
 * live search re-stamped between the read and the write is left as the search
 * wrote it. Returns how many rows changed; a second run returns 0.
 */
export async function reclassifyBufferItems(): Promise<{ updated: number }> {
  let updated = 0
  let cursor: string | null = null
  const unknownLabels = new Map<string, number>()

  for (;;) {
    const rows: LegacyRow[] = await prisma.bufferItem.findMany({
      where: {
        classifierVersion: { lt: BUFFER_CLASSIFIER_VERSION },
        ...(cursor !== null ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: BUFFER_RECLASSIFY_BATCH_SIZE,
      select: legacyRowSelect,
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    const docs = await resolvedDocumentsFor(rows.filter((r) => r.title === null))
    const results = await prisma.$transaction(
      rows.map((r) =>
        prisma.bufferItem.updateMany({
          where: { id: r.id, classifierVersion: { lt: BUFFER_CLASSIFIER_VERSION } },
          data: v1Data(r, docs.get(`${r.projectId} ${r.ark}`), unknownLabels),
        }),
      ),
    )
    for (const res of results) updated += res.count
    if (rows.length < BUFFER_RECLASSIFY_BATCH_SIZE) break
  }

  for (const [label, count] of unknownLabels) {
    console.warn(`[vocab] unknown dc:type "${label}" (${count} buffer row(s)) → other`)
  }
  log(`updated=${updated}`)
  return { updated }
}
