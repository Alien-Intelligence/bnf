// models/documents/queries.ts
// Pure database access for the documents model.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import type { Document } from "@/lib/generated/prisma/client"

export class DocumentQueries {
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
