import "server-only"
// models/bnf-records/queries.ts
// Pure database access for the BnF record cache. Imports only from @/lib/db
// and ./schema. Public BnF data only: no method takes a project id, and nothing
// here is joined to a project table (playbook/sharing.md).

import { prisma } from "@/lib/db"
import {
  bnfRecordRow,
  type BnfRecordRow,
  type BnfRecordUpsertStatement,
  type BnfRecordWrite,
} from "./schema"

export class BnfRecordQueries {
  /**
   * The cached records among `arks`, in no particular order. There is no
   * freshness filter: an entry is permanent until an explicit refresh
   * overwrites it. The caller bounds the list (a batch).
   */
  static async foundAmong(arks: readonly string[]): Promise<BnfRecordRow[]> {
    if (arks.length === 0) return []
    return prisma.bnfRecord.findMany({
      where: { ark: { in: [...arks] } },
      ...bnfRecordRow,
    })
  }

  /**
   * Statements that store `records`, replacing an entry already held for the
   * ARK. Returned unexecuted so a caller can run them in the same
   * `$transaction` as its own writes.
   */
  static upsertStatements(records: readonly BnfRecordWrite[]): BnfRecordUpsertStatement[] {
    return records.map((r) =>
      prisma.bnfRecord.upsert({
        where: { ark: r.ark },
        create: { ark: r.ark, payload: r.payload, source: r.source },
        update: { payload: r.payload, source: r.source, fetchedAt: new Date() },
      }),
    )
  }

  /** Stores `records` whose ARK has no entry yet; an existing entry is left untouched. */
  static async insertMissing(records: readonly BnfRecordWrite[]): Promise<void> {
    if (records.length === 0) return
    await prisma.bnfRecord.createMany({
      data: records.map((r) => ({ ark: r.ark, payload: r.payload, source: r.source })),
      skipDuplicates: true,
    })
  }
}
