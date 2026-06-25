// lib/mcp/vocab.ts
// Vocabulary mapping tables for the BnF MCP normalization layer.
// Pure data + pure functions — no server-only import, safe on either side.
// See playbook/mcp-client.md and ai-memories/…/persistence-architecture/research/bnf-mcp-contract.md

/**
 * MARC 639-2 → ISO 639-1 language code mapping.
 * Unknown codes are stored as-is in Document.lang and logged at WARN.
 * Extend this table as we observe new codes in production.
 */
export const MARC_TO_ISO_LANG: Record<string, string> = {
  fre: "fr",
  eng: "en",
  lat: "la",
  deu: "de",
  ita: "it",
  spa: "es",
  por: "pt",
  nld: "nl",
  grc: "grc",
  gre: "el",
  rus: "ru",
  jpn: "ja",
  chi: "zh",
  ara: "ar",
  heb: "he",
}

/**
 * Gallica doc_type enum → our canonical docType.
 * These are the 9 values the Gallica SRU actually returns (MCP contract §doc_type).
 */
export const GALLICA_DOC_TYPE: Record<string, string> = {
  monographie: "book",
  image: "image",
  carte: "map",
  manuscrit: "manuscript",
  fascicule: "press",
  partition: "score",
  video: "video",
  son: "audio",
  typeAffiche: "poster",
}

/**
 * Gallica OAI-PMH typedoc set → our canonical docType.
 *
 * The OAI-PMH `oai_dc` record's <dc:type> values are generic physical-form
 * labels ("texte", "publication en série imprimée") that do NOT discriminate a
 * periodical from a monograph — both collapse to "book" via mapCatalogueDocType.
 * The authoritative discriminator is the header <setSpec> "gallica:typedoc:<cat>"
 * (verified live 2026-06-24 on bd6t511758012, a Figaro littéraire fascicule:
 * dc:type="texte" but setSpec="gallica:typedoc:periodiques:fascicules"). Keyed
 * on the FIRST segment after "gallica:typedoc:"; subcategories roll up. The full
 * top-level vocabulary is the live ListSets output (same date).
 */
export const GALLICA_TYPEDOC: Record<string, string> = {
  periodiques: "press",
  monographies: "book",
  cartes: "map",
  manuscrits: "manuscript",
  images: "image",
  objets: "image",
  partitions: "score",
  videos: "video",
  audio: "audio",
}

/**
 * Map a Gallica typedoc tail (e.g. "periodiques:fascicules" or "monographies")
 * to our canonical docType, or null when the category is unknown/absent. Only
 * the top-level (first ":"-segment) category is significant for docType.
 */
export function mapGallicaTypedoc(
  typedoc: string | null | undefined,
): string | null {
  if (typeof typedoc !== "string" || typedoc.trim() === "") return null
  const top = typedoc.trim().toLowerCase().split(":")[0]
  return GALLICA_TYPEDOC[top] ?? null
}

/**
 * The Gallica typedoc SUBcategory token (e.g. "fascicules", "titres", "plan",
 * "estampes"), or null when the typedoc has no second segment. Stored as
 * Document.subtype — a finer, Gallica-native facet than docType, used for RAG
 * and UI filtering. Kept verbatim (lowercased) rather than mapped: the subtype
 * vocabulary is Gallica's, not ours.
 */
export function gallicaSubtype(
  typedoc: string | null | undefined,
): string | null {
  if (typeof typedoc !== "string" || typedoc.trim() === "") return null
  const parts = typedoc.trim().toLowerCase().split(":")
  return parts.length > 1 && parts[1] !== "" ? parts[1] : null
}

/**
 * Map a Catalogue free-text doc_type string to our canonical docType.
 * Best-effort regex; returns null when nothing matches — caller falls back to
 * "other" AND must emit a structured WARN log so we can grow the map.
 */
export function mapCatalogueDocType(raw: string): string | null {
  const s = raw.toLowerCase()
  if (/p[ée]riodique|presse|journal/.test(s)) return "press"
  if (/carte|plan/.test(s)) return "map"
  if (/manuscrit/.test(s)) return "manuscript"
  if (/image|photo|estampe/.test(s)) return "image"
  if (/livre|imprim[eé]|texte|monographie/.test(s)) return "book"
  return null
}

/**
 * Derive `source` from the ARK identifier.
 * Accepts both full form (`ark:/12148/<id>`) and short form (`<id>`).
 *
 * Mapping (per MCP contract research §ARK formats):
 *   cb*           → "catalogue"   (Catalogue bibliographic notices / authority)
 *   bpt6k / btv1b / bd6t  → "gallica"    (digitized documents)
 *   temp-work/    → "databnf"    (semantic-tools temporary URI)
 *   anything else → "other"
 */
export function sourceFromArk(ark: string): string {
  const id = ark.replace(/^ark:\/\d+\//, "")
  if (id.startsWith("cb")) return "catalogue"
  if (/^(bpt6k|btv1b|bd6t)/.test(id)) return "gallica"
  if (id.startsWith("temp-work/")) return "databnf"
  return "other"
}

/**
 * Derive the IIIF manifest URL for a Gallica document.
 * Returns null for non-Gallica sources (no IIIF endpoint available).
 *
 * The returned URL is templated — existence is NOT verified here.
 * Caller should lazily HEAD-check on first access (slice 5+).
 */
export function iiifManifestUrl(ark: string, source: string): string | null {
  if (source !== "gallica") return null
  const full = ark.startsWith("ark:/") ? ark : `ark:/12148/${ark}`
  return `https://gallica.bnf.fr/iiif/${full}/manifest.json`
}
