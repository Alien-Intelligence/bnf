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
    // OCR availability — drives the detail panel's Océrisation/Ingestion fields
    // (with iiifManifestUrl for digitization). See classifyIngestion().
    ocrAvailable: true,
    // Resolution lifecycle: "pending" rows render a placeholder until their MCP
    // metadata lands; "failed" rows surface a resolution-error affordance.
    resolveStatus: true,
    // cb→Gallica canonicalization outcome on a notice that stayed a notice —
    // drives the detail panel's "promote" (api_error) vs "not on Gallica"
    // (not_digitized) affordance. Null for digitized docs / upgraded notices.
    canonicalStatus: true,
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
 *
 * `total` — count of documents matching the active filters (or the full
 * corpus when no filters are set). `total === 0` means:
 *   • no filters active → fresh project with zero documents
 *   • filters active    → the filter matches nothing ("no results" branch)
 *
 * `undatedCount` — count of RESOLVED documents with `year IS NULL` within the
 * filtered set. Informational; drives the "Période non datée (N)" tile.
 * Pending/failed stubs are excluded (their date is unknown, not absent).
 *
 * `pendingCount` / `failedCount` — documents whose BnF metadata is still
 * resolving in the background, or whose resolution exhausted its retries. These
 * are real corpus members (counted in `total`) but carry no type/lang/period
 * yet, so they are excluded from the facet records and surfaced separately by
 * the UI (a dedicated "En cours de résolution" bucket / tile) rather than
 * polluting the real distributions.
 *
 * `nextCursor` — opaque pagination cursor. Present when more documents exist
 * beyond the current `sample` page. Pass as `?cursor=` on the next request.
 * Format: `<versionSeq>:<lastArk>` (stable for the same version + filters).
 */
export type CorpusSnapshot = {
  versionSeq: number
  versionStatus: CorpusVersionStatus
  total: number
  undatedCount: number
  /** Members still resolving metadata in the background (counted in `total`). */
  pendingCount: number
  /** Members whose metadata resolution exhausted its retries. */
  failedCount: number
  facets: {
    type: Record<string, number>
    lang: Record<string, number>
    source: Record<string, number>
    /** Per-decade buckets, e.g. "1880s", "1890s". Nulls are skipped. */
    period: Record<string, number>
  }
  /**
   * Per-session attribution facet: how many documents in the current filtered
   * head set each AppSession contributed. A document contributed by several
   * sessions is counted once under each (multi-session attribution). Carries the
   * session `title` so the UI can label the facet/chip without a second lookup —
   * which is why it is a dedicated array rather than a `Record` inside `facets`.
   * Sorted by `count` descending. Empty when no session has contributed (e.g. a
   * pre-existing corpus with no contribution rows — these are not backfilled).
   */
  sessions: { sessionId: string; title: string; count: number }[]
  /**
   * Numérisation & océrisation breakdown — the ingestability picture for the
   * comprehension panel. Computed over RESOLVED documents only (OCR/digitization
   * is unknown for pending/failed stubs), so `resolved` is the denominator for
   * "Numérisés X / Y", not `total`. Buckets are mutually exclusive and sum to
   * `resolved`. See classifyIngestion() in models/documents/schema.ts.
   */
  numerisation: {
    /** Resolved documents classified here (the bucket denominator). */
    resolved: number
    /** Have a Gallica IIIF surface (ocr + vision + sansTexte). */
    digitized: number
    /** Will be written to the index (ocr + vision). */
    ingestable: number
    /** Has an OCR text layer → ingested via text. */
    ocr: number
    /** Digitized image without OCR → ingested via vision description. */
    vision: number
    /** Digitized text without OCR → not ingested. */
    sansTexte: number
    /** Not digitized → not ingested. */
    nonNumerise: number
  }
  sample: DocumentRow[]
  nextCursor?: string
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
