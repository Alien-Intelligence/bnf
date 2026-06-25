// lib/bnf/types.ts
// Shared shapes for resolved BnF documents.
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
  subject?: string[]
  publisher?: string
  isbn?: string
  issn?: string
  catalogue_url?: string
  gallica_url?: string
  ocr_available?: boolean
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
