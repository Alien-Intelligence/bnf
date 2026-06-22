/**
 * lib/citations/external.ts
 *
 * Derive BnF / Gallica / IIIF external URLs from (ark, folio).
 *
 * Rules (from playbook/citations.md § "External URLs — derived only"):
 *   - Never store a constructed IIIF URL alongside a citation row.
 *     Storage is duplication; if the template changes, every stored URL is
 *     stale.
 *   - Always prefer `Document.iiifManifestUrl` when the MCP provided a
 *     canonical manifest; fall back to the template otherwise.
 *   - The side panel always offers all three links so the librarian can pick
 *     the surface they want.
 *
 * URL templates live in lib/constants.ts — the single source of truth.
 */

import {
  GALLICA_IIIF_VIEWER_URL,
  GALLICA_ITEM_URL,
  IIIF_IMAGE_URL,
  IIIF_MANIFEST_URL,
} from "@/lib/constants"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CitationLinks = {
  /** Gallica item page (opens the scanned page in the Gallica viewer). */
  gallica: string
  /** IIIF image (JPEG, "full" size by default). */
  image: string
  /** IIIF manifest (canonical when available, template-derived as fallback). */
  manifest: string
}

/**
 * Derive all external links for a citation.
 *
 * @param c              The citation — needs `ark` and `folio`.
 * @param iiifManifest   If the Document row already carries a canonical IIIF
 *                       manifest URL (from the MCP), pass it here.  It takes
 *                       precedence over the template-derived fallback.
 */
export function citationLinks(
  c: { ark: string; folio: number },
  iiifManifest?: string | null,
): CitationLinks {
  return {
    gallica: GALLICA_ITEM_URL(c.ark, c.folio),
    image: IIIF_IMAGE_URL(c.ark, c.folio),
    manifest: iiifManifest ?? IIIF_MANIFEST_URL(c.ark),
  }
}

/**
 * Gallica item page URL for a given ARK + folio.
 * Thin re-export so call sites can import from a single location.
 */
export { GALLICA_ITEM_URL as gallicaItemUrl }

/**
 * Gallica IIIF (Universal) viewer URL for a document (no folio).
 * The "open on Gallica" surface, distinct from the exact-folio item page.
 */
export { GALLICA_IIIF_VIEWER_URL as gallicaViewerUrl }

/**
 * IIIF image URL for a given ARK + folio.
 * `size` defaults to "full" (matches the Gallica API default).
 */
export { IIIF_IMAGE_URL as iiifImageUrl }

/**
 * IIIF manifest URL for a given ARK.
 * Use only as a fallback when the Document row has no canonical manifest.
 */
export { IIIF_MANIFEST_URL as iiifManifestUrl }
