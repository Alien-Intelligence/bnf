// lib/buffer/enricher.ts
// Background metadata enrichment for BARE buffer rows — the BufferItem table is
// the work queue (enrichStatus = pending), on the resolver's model
// (lib/documents/resolver.ts).
//
// Why: buffer_add stages ARKs with no metadata. On 0.18.1 they stayed bare
// forever (99 % of the 17 422 prod buffer_add rows had no title), so every
// filter the librarian asked for — "garde la presse métropolitaine" — had
// nothing to work on (feedback #10a).
//
// Order per batch (Decision 8 of the Track E plan):
//   1. Copy from a resolved Document of the same project — zero BnF cost.
//   2. The rest through BnfDirectClient.resolveArksForStaging: the broker-routed
//      OAI-PMH record for Gallica (carries the typedoc, the only press
//      discriminator), the catalogue SRU for `cb…`. Never the MCP (new app
//      egress belongs on the broker — playbook/mcp-client.md) and never the
//      manifest (its bucket is the ingestion bottleneck).
//   3. A failure increments enrichAttempts; the row is failed at the ceiling,
//      or at once when the BnF does not know the ARK.
//
// Execution: kicked via `after()` by buffer_add, resumed at boot and by a
// periodic sweep from instrumentation.ts. Never inline in a tool call. Every
// BnF call is bounded by the client's per-attempt timeouts (§14); a pass is
// bounded by BUFFER_ENRICH_BATCH_SIZE × BUFFER_ENRICH_DRAIN_MAX_BATCHES rows and
// has no in-loop sleep — a transient failure is retried by the next pass.
import "server-only"

import { after } from "next/server"

import {
  BUFFER_CLASSIFIER_VERSION,
  BUFFER_ENRICH_BATCH_SIZE,
  BUFFER_ENRICH_DRAIN_MAX_BATCHES,
  BUFFER_ENRICH_MAX_ATTEMPTS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { BnfDirectClient } from "@/lib/bnf/direct"
import type { BnfMcpResolveError, BnfMcpResolveResult } from "@/lib/bnf/types"
import { BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { normalizeMany } from "@/lib/mcp/normalize"
import type { Prisma } from "@/lib/generated/prisma/client"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "@/models/buffer/schema"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { bufferMetadataFromDocument, stringField, type ResolvedDocumentFields } from "./classify"

/** The one method the drain needs — BnfDirectClient in production, a counting
 *  fake in tests. */
export interface BufferEnrichClient {
  resolveArksForStaging(arks: string[]): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>>
}

function log(msg: string): void {
  console.log(`[buffer-enrich] ${msg}`)
}

/** At most one drain per project at a time; a kick during a drain sets
 *  `rerun` so rows staged meanwhile are picked up, never dropped. */
const active = new Map<string, { rerun: boolean }>()

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The buffer columns a resolved record fills — the Document copy and the BnF
 *  path write the same shape, in the current classification. */
function resolvedData(doc: ResolvedDocumentFields): Prisma.BufferItemUpdateInput {
  return {
    ...bufferMetadataFromDocument(doc),
    docTypeRaw: stringField(doc.rawMetadata, "doc_type"),
    gallicaUrl: stringField(doc.rawMetadata, "gallica_url"),
    catalogueUrl: stringField(doc.rawMetadata, "catalogue_url"),
    classifierVersion: BUFFER_CLASSIFIER_VERSION,
    enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED,
    enrichError: null,
  }
}

/**
 * Enrich every pending candidate row of a project. Re-entrant-safe: concurrent
 * calls coalesce into one active drain that re-checks before exiting. `deps`
 * has no default — production passes the broker-routed BnfDirectClient.
 */
export async function enrichPendingForProject(
  projectId: string,
  deps: { client: BufferEnrichClient },
): Promise<void> {
  const existing = active.get(projectId)
  if (existing) {
    existing.rerun = true
    return
  }
  const state = { rerun: false }
  active.set(projectId, state)
  try {
    do {
      state.rerun = false
      await drainOnce(projectId, deps.client)
    } while (state.rerun)
  } finally {
    active.delete(projectId)
  }
}

/** One bounded pass over the project's pending candidates. */
async function drainOnce(projectId: string, client: BufferEnrichClient): Promise<void> {
  const pending = await prisma.bufferItem.findMany({
    where: {
      projectId,
      status: BUFFER_STATUS.CANDIDATE,
      enrichStatus: BUFFER_ENRICH_STATUS.PENDING,
      enrichAttempts: { lt: BUFFER_ENRICH_MAX_ATTEMPTS },
    },
    select: { ark: true, enrichAttempts: true },
    orderBy: [{ enrichAttempts: "asc" }, { createdAt: "asc" }],
    take: BUFFER_ENRICH_BATCH_SIZE * BUFFER_ENRICH_DRAIN_MAX_BATCHES,
  })
  if (pending.length === 0) return

  log(`project ${projectId}: enriching ${pending.length} bare candidate(s)`)
  const attemptsByArk = new Map(pending.map((p) => [p.ark, p.enrichAttempts]))
  let fromDocuments = 0
  let fromBnf = 0
  let failed = 0
  let retry = 0

  const write = (ark: string, data: Prisma.BufferItemUpdateInput) =>
    prisma.bufferItem.update({ where: { projectId_ark: { projectId, ark } }, data })

  for (const batch of chunk(pending.map((p) => p.ark), BUFFER_ENRICH_BATCH_SIZE)) {
    // 1. Same-project resolved Documents: free.
    const docs = await prisma.document.findMany({
      where: { projectId, ark: { in: batch }, resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED },
      select: {
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
    const fromDoc = new Set(docs.map((d) => d.ark))
    for (const d of docs) await write(d.ark, resolvedData(d))
    fromDocuments += docs.length

    // 2. The rest through the broker.
    const rest = batch.filter((ark) => !fromDoc.has(ark))
    if (rest.length === 0) continue
    const results = await client.resolveArksForStaging(rest)
    const normalised = normalizeMany(results.filter((r) => r.ok).map((r) => r.document))
    const byArk = new Map(normalised.map((n) => [n.ark, n]))

    for (const r of results) {
      const doc = byArk.get(r.ark)
      if (r.ok && doc) {
        await write(
          r.ark,
          resolvedData({
            ark: doc.ark,
            title: doc.title,
            author: doc.author ?? null,
            year: doc.year ?? null,
            dateLabel: doc.dateLabel ?? null,
            docType: doc.docType,
            lang: doc.lang ?? null,
            rawMetadata: doc.rawMetadata,
          }),
        )
        fromBnf += 1
        continue
      }
      // The call failed, or it succeeded with an unusable record (no title).
      const reason = r.ok ? "métadonnées incomplètes (titre manquant)" : describeError(r.error)
      const attempts = (attemptsByArk.get(r.ark) ?? 0) + 1
      const terminal = (!r.ok && r.error instanceof BnfMcpNotFoundError) || attempts >= BUFFER_ENRICH_MAX_ATTEMPTS
      if (terminal) failed += 1
      else retry += 1
      await write(r.ark, {
        enrichAttempts: attempts,
        enrichError: reason,
        ...(terminal ? { enrichStatus: BUFFER_ENRICH_STATUS.FAILED } : {}),
      })
    }
  }

  log(
    `project ${projectId}: drain done — from-documents=${fromDocuments}, from-bnf=${fromBnf}, ` +
      `failed=${failed}, still-pending=${retry}`,
  )
}

/**
 * Schedule a drain after the current response is flushed. Called from the
 * buffer_add tool (inside the request scope); the drain outlives the request
 * and its BnF calls are individually bounded.
 */
export function kickBufferEnrich(projectId: string): void {
  after(async () => {
    await enrichPendingForProject(projectId, { client: new BnfDirectClient() }).catch((err: unknown) => {
      console.error(`[buffer-enrich] drain failed for project ${projectId}:`, err)
    })
  })
}

/**
 * Boot resume and periodic sweep: drain every project that still has pending
 * candidates under the attempt ceiling. Fire-and-forget from
 * instrumentation.ts — never blocks serving.
 */
export async function resumePendingBufferEnrich(): Promise<void> {
  const projects = await prisma.bufferItem.findMany({
    where: {
      status: BUFFER_STATUS.CANDIDATE,
      enrichStatus: BUFFER_ENRICH_STATUS.PENDING,
      enrichAttempts: { lt: BUFFER_ENRICH_MAX_ATTEMPTS },
    },
    distinct: ["projectId"],
    select: { projectId: true },
  })
  if (projects.length === 0) return
  log(`resume — ${projects.length} project(s) with pending candidates`)
  const client = new BnfDirectClient()
  for (const { projectId } of projects) {
    await enrichPendingForProject(projectId, { client }).catch((err: unknown) => {
      console.error(`[buffer-enrich] resume drain failed for project ${projectId}:`, err)
    })
  }
}
