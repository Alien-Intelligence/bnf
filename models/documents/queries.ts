import "server-only"
// models/documents/queries.ts
// Pure database access for the documents model.
// Imports only from @/lib/db and ./schema.

import { prisma } from "@/lib/db"
import type { Document, Prisma } from "@/lib/generated/prisma/client"
import { DOCUMENT_RESOLVE_STATUS } from "./schema"

/** The fields of a resolved Document a bare buffer row copies. */
const resolvedDocumentSelect = {
  projectId: true,
  ark: true,
  title: true,
  author: true,
  year: true,
  dateLabel: true,
  docType: true,
  lang: true,
  rawMetadata: true,
} satisfies Prisma.DocumentSelect

export type ResolvedDocumentRow = Prisma.DocumentGetPayload<{ select: typeof resolvedDocumentSelect }>

export class DocumentQueries {
  /** Every distinct non-null `lang` value stored (a few dozen at most). */
  static async distinctLangs(): Promise<string[]> {
    const rows = await prisma.document.findMany({
      where: { lang: { not: null } },
      distinct: ["lang"],
      select: { lang: true },
    })
    return rows.flatMap((r) => (r.lang !== null ? [r.lang] : []))
  }

  /** Rewrite one stored `lang` value to another everywhere. Returns the count. */
  static async replaceLang(from: string, to: string | null): Promise<number> {
    const { count } = await prisma.document.updateMany({ where: { lang: from }, data: { lang: to } })
    return count
  }

  /**
   * The RESOLVED documents among the given ARKs of each project — the metadata
   * a bare buffer row can copy at no BnF cost. One query; the caller bounds
   * the ARK lists (a batch).
   */
  static async resolvedAmong(
    arksByProject: ReadonlyMap<string, readonly string[]>,
  ): Promise<ResolvedDocumentRow[]> {
    if (arksByProject.size === 0) return []
    return prisma.document.findMany({
      where: {
        resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
        OR: [...arksByProject].map(([projectId, arks]) => ({ projectId, ark: { in: [...arks] } })),
      },
      select: resolvedDocumentSelect,
    })
  }

  /**
   * Fetches a single document by its composite key (projectId, ark).
   * Returns null if not found.
   */
  static async getByArk(
    projectId: string,
    ark: string,
  ): Promise<Document | null> {
    return prisma.document.findUnique({
      where: { projectId_ark: { projectId, ark } },
    })
  }

  /**
   * Lists all documents that are members of a given corpus version.
   * Joins corpus_membership → document via the composite FK.
   *
   * `opts.take` limits the result set (used by the sample query in
   * CorpusQueries.snapshot). No pagination yet — full list support and
   * filter/search land in slice 2.
   */
  static async listByVersion(
    versionId: string,
    opts?: { take?: number },
  ): Promise<Document[]> {
    return prisma.document.findMany({
      where: {
        membership: { some: { versionId } },
      },
      take: opts?.take,
    })
  }
}
