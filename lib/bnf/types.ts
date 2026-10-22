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
  ocr_source?: "oai" | "manifest" | "image_like"
  /** Which source decided `pages`; `null` when no source gave a page count. */
  pages_source?: "oai" | "manifest" | null
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
