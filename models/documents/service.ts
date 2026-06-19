// models/documents/service.ts
// Business logic for document mutations.
// Used by the seed script (commit #10) and, in slice 3, by the MCP resolve
// path when the agent adds ARKs that don't yet have Document rows.
import "server-only"

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { DOCUMENT_RESOLVE_STATUS } from "./schema"
import { iiifManifestUrl, sourceFromArk } from "@/lib/mcp/vocab"

/** Shape of a document to upsert. Mirrors the Document table columns. */
export type DocumentUpsertData = Omit<
  Prisma.DocumentCreateInput,
  "project" | "membership"
> & {
  projectId: string
  ark: string
}

export class DocumentService {
  /**
   * Bulk-upserts document metadata rows.
   *
   * `skipDuplicates: true` makes the operation idempotent — re-seeding or
   * re-resolving the same ARK is safe. Existing rows are NOT updated; a
   * deliberate re-resolve (slice 3) should use an explicit update instead.
   *
   * Used by:
   *  - `prisma/seed.ts` (slice 1) to pre-create rows so CorpusService.addArks
   *    can reference them without MCP.
   *  - `models/agents/service.ts` (slice 3) after MCP bnf.resolve() returns
   *    document metadata for a new ARK.
   */
  static async upsertMany(
    projectId: string,
    docs: Array<Omit<DocumentUpsertData, "projectId">>,
  ): Promise<void> {
    if (docs.length === 0) return

    await prisma.document.createMany({
      // These rows carry full metadata, so they are born "resolved" — the
      // drainer must not pick them up. (createMany default would be "pending".)
      data: docs.map((d) => ({
        resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
        resolvedAt: new Date(),
        ...d,
        projectId,
      })),
      skipDuplicates: true,
    })
  }

  /**
   * Insert "stub" Document rows for ARKs being added to the corpus, carrying
   * only what is derivable from the ARK itself (source + IIIF manifest URL).
   * Metadata (title, year, lang, docType, …) is filled in later by the
   * background resolver. Idempotent: `skipDuplicates` means an ARK that already
   * has a row (stub or resolved) is left untouched.
   *
   * Returns the ARKs that were newly inserted (i.e. had no prior row), so the
   * caller can report how many are now pending.
   */
  static async createStubs(projectId: string, arks: string[]): Promise<string[]> {
    if (arks.length === 0) return []

    // Only the ARKs without an existing row become new stubs.
    const existing = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: { ark: true },
    })
    const existingSet = new Set(existing.map((d) => d.ark))
    const newArks = arks.filter((a) => !existingSet.has(a))
    if (newArks.length === 0) return []

    await prisma.document.createMany({
      data: newArks.map((ark) => {
        const source = sourceFromArk(ark)
        return {
          projectId,
          ark,
          source,
          iiifManifestUrl: iiifManifestUrl(ark, source),
          resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
        }
      }),
      skipDuplicates: true,
    })
    return newArks
  }
}
