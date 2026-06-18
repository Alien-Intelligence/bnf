// models/corpus/schema.ts
// Domain constants, named query shapes, and derived types for the corpus model.
// No imports from other model directories — schema.ts is the foundation layer.
// See playbook/models.md import diagram.

import { Prisma } from "@/lib/generated/prisma/client"

// ---------------------------------------------------------------------------
// Domain status enum
// ---------------------------------------------------------------------------

export const CORPUS_VERSION_STATUS = {
  DRAFT: "draft",
  SEALED: "sealed",
  INGESTED: "ingested",
  FAILED: "failed",
} as const

export type CorpusVersionStatus =
  (typeof CORPUS_VERSION_STATUS)[keyof typeof CORPUS_VERSION_STATUS]

// ---------------------------------------------------------------------------
// Named Prisma query shapes
// ---------------------------------------------------------------------------

/**
 * CorpusVersion with its membership ARKs (no Document join).
 * Used by advanceVersion() to read existing membership and by services that
 * need to know which ARKs belong to a version without the full document row.
 */
export const corpusVersionWithArks = {
  include: { membership: { select: { ark: true } } },
} satisfies Prisma.CorpusVersionDefaultArgs

export type CorpusVersionWithArks = Prisma.CorpusVersionGetPayload<
  typeof corpusVersionWithArks
>

/**
 * Minimal document projection returned to the comprehension panel.
 * Full document detail is served by DocumentQueries.getByArk().
 */
export const documentRow = {
  select: {
    ark: true,
    title: true,
    author: true,
    year: true,
    dateLabel: true,
    docType: true,
    lang: true,
    source: true,
    pages: true,
    excerpt: true,
    iiifManifestUrl: true,
  },
} satisfies Prisma.DocumentDefaultArgs

export type DocumentRow = Prisma.DocumentGetPayload<typeof documentRow>

// ---------------------------------------------------------------------------
// Composite types returned to the API layer
// ---------------------------------------------------------------------------

/**
 * The shape returned for the corpus comprehension panel (Constituer step).
 *
 * IMPORTANT: `sample` is bounded (CORPUS_SAMPLE_SIZE items). Never use
 * `sample.length` as a proxy for the corpus size — use `total` instead.
 * See playbook/corpus-versioning.md §"Sample is sampled".
 */
export type CorpusSnapshot = {
  versionSeq: number
  versionStatus: CorpusVersionStatus
  total: number
  facets: {
    type: Record<string, number>
    lang: Record<string, number>
    source: Record<string, number>
    /** Per-decade buckets, e.g. "1880s", "1890s". Nulls are skipped. */
    period: Record<string, number>
  }
  sample: DocumentRow[]
}

/**
 * Delta between two corpus versions: which ARKs were added and which removed.
 * Computed in CorpusQueries.diff(); never client-side (sample is sampled).
 */
export type CorpusDiff = {
  fromSeq: number
  toSeq: number
  added: string[]
  removed: string[]
  addedCount: number
  removedCount: number
}
