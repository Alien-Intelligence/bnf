// lib/bnf/types.ts
// Shared shapes for resolved BnF documents.
//
// Gallica resolution is a hybrid (SDS-945): the OAI-PMH record is always
// fetched first and supplies title/creator/date/language/publisher/subject,
// the typedoc (docType + subtype) and the raw view count. The IIIF manifest is
// fetched only for text-like documents OAI does not mark "mode texte"
// (fascicules, ~4 % of monographs, manuscripts, scores…), and then supplies
// only the OCR flag, the authoritative page count and the OCR rate. Image-like
// documents never trigger a manifest call. `ocr_source` / `pages_source` record
// which of the two produced each value.
//
// These were originally defined in lib/mcp/bnf-client.ts (the BnF MCP client),
// but resolution moved to the broker-routed BnfDirectClient (lib/bnf/direct.ts).
// They now live here as the contract between the resolver and the normalize
// layer. The `BnfMcp` name prefix is kept for continuity with normalize.ts /
// Document.rawMetadata; the shapes themselves are MCP-agnostic.

import { DOCUMENT_CANONICAL_STATUS } from "@/models/documents/schema"

/**
 * What a resolve is for. It decides whether the IIIF manifest may be fetched:
 *   - `commit`  — the ARK enters a corpus (resolver, backfill): the full hybrid
 *     rule applies, including the manifest for text-like documents OAI does not
 *     mark "mode texte".
 *   - `staging` — the ARK is parked in the research buffer: OAI only, never the
 *     manifest. Staging must not spend the manifest bucket (the ingestion
 *     bottleneck), and the OCR flag is not needed before commit.
 */
export const RESOLVE_MODE = { COMMIT: "commit", STAGING: "staging" } as const
export type ResolveMode = (typeof RESOLVE_MODE)[keyof typeof RESOLVE_MODE]

/**
 * The `rawMetadata` keys other code reads back from a stored record to tell how
 * it was resolved (the OAI typedoc, and the provenance of the OCR verdict and
 * of `pages`). The names of the fields on BnfMcpDocumentDetail below.
 */
export const RAW_METADATA_KEY = {
  GALLICA_TYPEDOC: "gallica_typedoc",
  OCR_SOURCE: "ocr_source",
  PAGES_SOURCE: "pages_source",
} as const

/** Which source decided `ocr_available`. */
export const OCR_SOURCE = { OAI: "oai", MANIFEST: "manifest", IMAGE_LIKE: "image_like" } as const
export type OcrSource = (typeof OCR_SOURCE)[keyof typeof OCR_SOURCE]

/** Which source decided `pages`. */
export const PAGES_SOURCE = { OAI: "oai", MANIFEST: "manifest" } as const
export type PagesSource = (typeof PAGES_SOURCE)[keyof typeof PAGES_SOURCE]

/**
 * Outcome status of classifying a catalogue (`cb…`) ARK against its digitized
 * Gallica reproduction. `UPGRADED` is transient to the classification (the ARK
 * is substituted); the other two are persisted as Document.canonicalStatus.
 */
export const CANONICAL_OUTCOME_STATUS = {
  UPGRADED: "upgraded",
  NOT_DIGITIZED: DOCUMENT_CANONICAL_STATUS.NOT_DIGITIZED,
  API_ERROR: DOCUMENT_CANONICAL_STATUS.API_ERROR,
} as const

/**
 * Shape of a resolved document — produced by BnfDirectClient.resolveArk
 * (Gallica via OAI-PMH, Catalogue via SRU) and consumed by normalize.ts.
 *
 * Gallica documents use `creator`; Catalogue records use `author`. Remaining
 * fields are captured by the index signature; normalize.ts Zod-parses the full
 * payload from Document.rawMetadata.
 */
export interface BnfMcpDocumentDetail {
  ark: string
  title?: string
  author?: string
  creator?: string
  date?: string
  language?: string
  doc_type?: string
  /**
   * Gallica OAI-PMH typedoc set tail (e.g. "periodiques:fascicules",
   * "cartes:plan") read from the record header <setSpec>. The authoritative
   * docType discriminator AND the source of Document.subtype — the <dc:type>
   * physical-form labels alone collapse periodicals to "book". Gallica-only.
   */
  gallica_typedoc?: string
  /** Deduplicated, trimmed <dc:subject> values (OAI, catalogue). Omitted when none. */
  subject?: string[]
  publisher?: string
  isbn?: string
  issn?: string
  catalogue_url?: string
  gallica_url?: string
  /**
   * Raw "Nombre total de vues" from the OAI record. NOT a page count: it is
   * collection-level for periodical issues (bpt6k268418n: 4 real folios, OAI
   * says 3197). normalize decides whether it becomes `pages`.
   */
  oai_total_views?: number
  /**
   * Authoritative page count. Set only from the IIIF manifest canvas count; the
   * OAI parser never sets it. `null` = known to be unknown.
   */
  pages?: number | null
  /**
   * Whether the document has a text layer. The OAI parser sets `true` when the
   * record says "mode texte" and leaves it UNSET otherwise (OAI silence proves
   * nothing). The resolver then sets it: `false` for image-like documents, the
   * manifest verdict for text-like ones, or `null` when the manifest says
   * not-found (unknown; never `false`, which would route to paid OCR).
   */
  ocr_available?: boolean | null
  /** Which source decided `ocr_available`. */
  ocr_source?: OcrSource
  /** Which source decided `pages`; `null` when no source gave a page count. */
  pages_source?: PagesSource | null
  /** Manifest "Taux OCR" (text-layer rate), when the manifest was fetched. */
  taux_ocr?: number
  nqa_score?: number
  [key: string]: unknown
}

/** One successful entry from BnfDirectClient.resolveArks. */
export interface BnfMcpResolveResult {
  ark: string
  ok: true
  document: BnfMcpDocumentDetail
}

/** One failed entry from BnfDirectClient.resolveArks. */
export interface BnfMcpResolveError {
  ark: string
  ok: false
  error: unknown
}
