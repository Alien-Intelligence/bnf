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
