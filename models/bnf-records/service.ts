import "server-only"
// models/bnf-records/service.ts
// The global BnF record cache (see prisma BnfRecord). One record per ARK serves
// every caller that would otherwise ask the BnF again: the metadata resolver
// (cross-project re-adds), the buffer enricher (so the commit-time resolve is a
// hit) and the canonicalizer's upgraded stubs.
//
// Two kinds of entry, told apart by the payload alone:
//   - COMPLETE: the record plus, for Gallica, the OCR verdict (`ocr_source`).
//     A hit costs zero BnF calls.
//   - STAGED: an OAI-only record, written by the buffer enricher (buffer rows
//     need no OCR flag before commit) or stored with an unknown OCR verdict.
//     It has no `ocr_source`. The commit-time resolver completes it by running
//     the OCR rule on it (a manifest call only for a text-like document OAI does
//     not mark "mode texte"); it never fetches the OAI record again.
//
// No TTL: an entry changes only through an explicit refresh
// (scripts/fix-doc-types.ts --refresh), which overwrites it.

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import type { BnfMcpDocumentDetail, BnfMcpResolveResult } from "@/lib/bnf/types"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { DOCUMENT_SOURCE } from "@/models/documents/schema"
import { BnfRecordQueries } from "./queries"
import { BNF_RECORD_SOURCE, type BnfRecordSource, type BnfRecordWrite } from "./schema"

/** The OCR-verdict fields a STAGED entry must not carry (they are all `rule 4`'s output). */
const OCR_VERDICT_KEYS = ["ocr_available", "ocr_source", "pages", "pages_source", "taux_ocr"] as const

function sourceOf(ark: string): BnfRecordSource {
  return sourceFromArk(ark) === DOCUMENT_SOURCE.CATALOGUE
    ? BNF_RECORD_SOURCE.CATALOGUE_SRU
    : BNF_RECORD_SOURCE.OAI_GALLICA
}

function isRecordObject(payload: unknown): payload is BnfMcpDocumentDetail {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
}

/**
 * The payload to store for a resolved record. A Gallica record whose OCR rule
 * ran but could not decide (`ocr_available` null: the manifest was not found)
 * is stored as a STAGED entry, so the unknown verdict is never frozen into the
 * permanent cache and the next commit-time resolve retries the rule.
 */
function payloadFor(ark: string, doc: BnfMcpDocumentDetail): Prisma.InputJsonObject {
  const verdictUndecided =
    sourceFromArk(ark) !== DOCUMENT_SOURCE.CATALOGUE && doc.ocr_source !== undefined && doc.ocr_available == null
  const stored: BnfMcpDocumentDetail = { ...doc }
  if (verdictUndecided) for (const key of OCR_VERDICT_KEYS) delete stored[key]
  // Plain JSON: drops `undefined` members, rejects nothing Prisma would.
  return JSON.parse(JSON.stringify(stored)) as Prisma.InputJsonObject
}

function writesFor(results: readonly BnfMcpResolveResult[]): BnfRecordWrite[] {
  return results.map((r) => ({ ark: r.ark, payload: payloadFor(r.ark, r.document), source: sourceOf(r.ark) }))
}

export class BnfRecordService {
  /**
   * The cached records among `arks`, keyed by the ARK as asked. An entry whose
   * payload is not a JSON object is corrupt: it is reported and treated as a
   * miss, so the caller fetches the record again and its write repairs the entry.
   */
  static async foundAmong(arks: readonly string[]): Promise<Map<string, BnfMcpDocumentDetail>> {
    const rows = await BnfRecordQueries.foundAmong(arks)
    const found = new Map<string, BnfMcpDocumentDetail>()
    for (const row of rows) {
      if (!isRecordObject(row.payload)) {
        console.warn(`[bnf-record] corrupt cache entry ignored: ${row.ark}`)
        continue
      }
      found.set(row.ark, row.payload)
    }
    return found
  }

  /**
   * True when `doc` is a STAGED Gallica entry: its OCR rule has not run yet.
   * Catalogue records have no OCR rule and are always complete.
   */
  static needsOcrRule(ark: string, doc: BnfMcpDocumentDetail): boolean {
    return sourceFromArk(ark) !== DOCUMENT_SOURCE.CATALOGUE && doc.ocr_source === undefined
  }

  /**
   * Statements storing `results`, replacing any entry held. Unexecuted, so the
   * resolver runs them in the same `$transaction` as its document writes.
   */
  static upsertStatements(results: readonly BnfMcpResolveResult[]): Prisma.PrismaPromise<unknown>[] {
    return BnfRecordQueries.upsertStatements(writesFor(results))
  }

  /** Stores `results` and replaces any entry held (a completed or refreshed record). */
  static async upsertMany(results: readonly BnfMcpResolveResult[]): Promise<void> {
    await prisma.$transaction(this.upsertStatements(results))
  }

  /**
   * Stores the records that have no entry yet and leaves an existing one alone,
   * so a STAGED record can never downgrade a COMPLETE entry written meanwhile.
   */
  static async insertMissing(results: readonly BnfMcpResolveResult[]): Promise<void> {
    await BnfRecordQueries.insertMissing(writesFor(results))
  }
}
