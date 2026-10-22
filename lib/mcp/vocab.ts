// lib/mcp/vocab.ts
// Vocabulary mapping tables for the BnF MCP normalization layer.
// Pure data + pure functions — no server-only import, safe on either side.
// See playbook/mcp-client.md and ai-memories/…/persistence-architecture/research/bnf-mcp-contract.md
import {
  DOC_TYPE_CODE,
  DOCUMENT_SOURCE,
  type DocTypeCode,
  type DocumentSource,
} from "@/models/documents/schema"
import { fullBnfArk } from "@/lib/validation/ark"

/**
 * MARC 639-2 → ISO 639-1 language code mapping.
 * Unknown codes are stored as-is in Document.lang and logged at WARN.
 * Extend this table as we observe new codes in production.
 *
 * Both ISO 639-2 columns are present. MARC records (what the catalogue SRU and
 * OAI-PMH actually carry) use the BIBLIOGRAPHIC codes — `ger`, `dut`, `cze`,
 * `rum`, `per` — while the first version of this table only had the
 * terminology codes (`deu`, `nld`), so German documents stayed `ger` in
 * Document.lang and no `lang: ["de"]` filter ever matched them (Track E found
 * bug; session 1ade61e9… hit `matched: 0` on `lang:["ger"]`).
 */
export const MARC_TO_ISO_LANG: Record<string, string> = {
  // Terminology codes
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
  // Bibliographic codes (MARC 21 / UNIMARC)
  ger: "de",
  dut: "nl",
  cze: "cs",
  rum: "ro",
  per: "fa",
  fra: "fr",
  slo: "sk",
  scc: "sr",
  scr: "hr",
  wel: "cy",
  ice: "is",
  arm: "hy",
  geo: "ka",
  may: "ms",
  tib: "bo",
  baq: "eu",
  alb: "sq",
  mac: "mk",
  bur: "my",
  mao: "mi",
}

/** Casefold for vocabulary matching: trim, lowercase, diacritics removed. */
function foldLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
}

/**
 * French and English language NAMES that show up where a code should be
 * (catalogue free text, hand-typed filters). Folded keys.
 */
const LANGUAGE_NAME_TO_ISO: Record<string, string> = {
  francais: "fr",
  french: "fr",
  anglais: "en",
  english: "en",
  allemand: "de",
  german: "de",
  latin: "la",
  italien: "it",
  italian: "it",
  espagnol: "es",
  spanish: "es",
  grec: "el",
  neerlandais: "nl",
  russe: "ru",
}

/**
 * The canonical language code for a raw BnF language value, or null for an
 * empty one. MARC codes (both columns) map to ISO 639-1; a 2-letter code
 * passes through lowercased; French/English language names map to their code;
 * anything else is kept as the lowercased raw value — the raw-lowercase
 * fallback playbook/mcp-client.md requires, never null/empty for a value that
 * was there.
 */
export function canonicalLang(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const folded = foldLabel(trimmed)
  const marc = MARC_TO_ISO_LANG[folded]
  if (marc !== undefined) return marc
  if (/^[a-z]{2}$/.test(folded)) return folded
  const named = LANGUAGE_NAME_TO_ISO[folded]
  if (named !== undefined) return named
  return trimmed.toLowerCase()
}

/**
 * Gallica doc_type → our canonical docType, for READING a record back.
 * Tolerant by design: it keeps values the SRU may still emit on old records
 * even where they are no longer usable as a search filter.
 */
export const GALLICA_DOC_TYPE: Record<string, DocTypeCode> = {
  monographie: DOC_TYPE_CODE.BOOK,
  image: DOC_TYPE_CODE.IMAGE,
  carte: DOC_TYPE_CODE.MAP,
  manuscrit: DOC_TYPE_CODE.MANUSCRIPT,
  fascicule: DOC_TYPE_CODE.PRESS,
  partition: DOC_TYPE_CODE.SCORE,
  objet: DOC_TYPE_CODE.OBJECT,
  sonore: DOC_TYPE_CODE.AUDIO,
  video: DOC_TYPE_CODE.VIDEO,
  son: DOC_TYPE_CODE.AUDIO,
  typeAffiche: DOC_TYPE_CODE.POSTER,
}

/**
 * The doc_type values that are SEARCHABLE — a strict subset of the map above,
 * and the only list we may offer the agent.
 *
 * These two sets are NOT the same, and treating them as one is how three dead
 * values survived in the tool schema. Probed live 2026-09-16 as
 * `dc.type all "<v>"`: `typeAffiche` and `son` return 0, `video` answers HTTP
 * 500, and `vidéo` returns 0 despite appearing in BnF's own published list —
 * so none of them are here. An enum value that always returns zero is read by
 * the agent as absence, which is the failure this whole change exists to stop.
 *
 * Kept in step with `_DOC_TYPES` in mcp-bnf (`tools/search/search_gallica.py`),
 * which validates the value and will reject anything not on its list.
 */
export const GALLICA_SEARCHABLE_DOC_TYPE = [
  "fascicule",
  "monographie",
  "image",
  "objet",
  "manuscrit",
  "carte",
  "partition",
  "sonore",
] as const

/**
 * The `sort` keys bnf_search_gallica accepts, verbatim (mcp-bnf
 * search_gallica.py `_SORT_KEYS`). Ignored by mcp-bnf when `cql` is given —
 * corpus_search rejects that combination rather than dropping the sort.
 */
export const GALLICA_SORT_KEYS = [
  "dc.date/sort.descending",
  "dc.date/sort.ascending",
  "dc.title/sort.ascending",
  "dc.creator/sort.ascending",
  "ocr.quality/sort.descending",
  "indexationdate/sort.descending",
] as const

/**
 * mcp-bnf's own default for Gallica `collapsing` (search_gallica.py ToolInput):
 * the volumes/issues of one periodical come back as ONE collection record.
 * Used only to record the mode of a search that did not set it, when an older
 * mcp-bnf does not echo it back.
 */
export const GALLICA_COLLAPSING_DEFAULT = true

/**
 * Strict search-filter → canonical docType map, for a hit staged by a
 * corpus_search that was run WITH a `doc_type` filter: the filter the search
 * was run with says more about every hit than the hit's own dc:type label
 * (Gallica labels press issues and monographs alike as `text`). `satisfies`
 * makes a new searchable value without a mapping a type error.
 */
export const GALLICA_FILTER_DOC_TYPE = {
  fascicule: DOC_TYPE_CODE.PRESS,
  monographie: DOC_TYPE_CODE.BOOK,
  image: DOC_TYPE_CODE.IMAGE,
  objet: DOC_TYPE_CODE.OBJECT,
  manuscrit: DOC_TYPE_CODE.MANUSCRIPT,
  carte: DOC_TYPE_CODE.MAP,
  partition: DOC_TYPE_CODE.SCORE,
  sonore: DOC_TYPE_CODE.AUDIO,
} as const satisfies Record<(typeof GALLICA_SEARCHABLE_DOC_TYPE)[number], DocTypeCode>

/** GALLICA_DOC_TYPE keyed by its folded label, for a case-insensitive lookup. */
const GALLICA_DOC_TYPE_FOLDED: Record<string, DocTypeCode> = Object.fromEntries(
  Object.entries(GALLICA_DOC_TYPE).map(([k, v]) => [foldLabel(k), v]),
)

/**
 * Canonical docType for a free-text dc:type label, from a search hit or an
 * old buffer row. The 86 765 prod buffer rows carried 25 distinct raw labels
 * (`text`, `image fixe`, `Monographie imprimée`, `Genre musical : valse`,
 * `manuscript cartographic resource`, …) — this is the table that folds them.
 *
 * `code` is null for an empty label (nothing to classify — not an error);
 * `known` is false when the label matched no rule and fell to `other`, so the
 * caller can log it and the table can grow. `text`/`texte`/`printed text` map
 * to the code `text` ("texte imprimé, nature indéterminée"): Gallica gives
 * monographs and press issues the same label, so calling it `book` would
 * mislabel press as books.
 *
 * Rules run in order, and the order matters: cartographic before manuscript
 * ("manuscript cartographic resource" is a map), music before manuscript
 * ("manuscript music" is a score), affiche before image. Only the part before
 * the first " | " is classified (Gallica joins several labels that way).
 */
export function canonicalDocTypeFromLabel(
  raw: string | null | undefined,
): { code: DocTypeCode | null; known: boolean } {
  if (typeof raw !== "string" || raw.trim() === "") return { code: null, known: true }
  const label = foldLabel(raw.split(" | ")[0])
  if (label === "") return { code: null, known: true }

  const enumMatch = GALLICA_DOC_TYPE_FOLDED[label]
  if (enumMatch !== undefined) return { code: enumMatch, known: true }

  const rules: Array<[RegExp, DocTypeCode]> = [
    [/cartograph|^carte|^map$|^plan$/, DOC_TYPE_CODE.MAP],
    [/^genre musical|musique|notated music|partition|manuscript music/, DOC_TYPE_CODE.SCORE],
    [/manuscri/, DOC_TYPE_CODE.MANUSCRIPT],
    [/affiche/, DOC_TYPE_CODE.POSTER],
    [/^image|still image|photograph|estampe|dessin/, DOC_TYPE_CODE.IMAGE],
    [/^sound|sonore|enregistrement sonore/, DOC_TYPE_CODE.AUDIO],
    [/^objet|^object|three dimensional/, DOC_TYPE_CODE.OBJECT],
    [/^video|moving image|film/, DOC_TYPE_CODE.VIDEO],
    [/monographie|livre|colloque/, DOC_TYPE_CODE.BOOK],
    [/^text$|^texte$|printed text|texte imprime/, DOC_TYPE_CODE.TEXT],
    [/archival material|archives/, DOC_TYPE_CODE.OTHER],
  ]
  for (const [re, code] of rules) {
    if (re.test(label)) return { code, known: true }
  }
  return { code: DOC_TYPE_CODE.OTHER, known: false }
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
export const GALLICA_TYPEDOC: Record<string, DocTypeCode> = {
  periodiques: DOC_TYPE_CODE.PRESS,
  monographies: DOC_TYPE_CODE.BOOK,
  cartes: DOC_TYPE_CODE.MAP,
  manuscrits: DOC_TYPE_CODE.MANUSCRIPT,
  images: DOC_TYPE_CODE.IMAGE,
  objets: DOC_TYPE_CODE.IMAGE,
  partitions: DOC_TYPE_CODE.SCORE,
  videos: DOC_TYPE_CODE.VIDEO,
  audio: DOC_TYPE_CODE.AUDIO,
}

/**
 * Map a Gallica typedoc tail (e.g. "periodiques:fascicules" or "monographies")
 * to our canonical docType, or null when the category is unknown/absent. Only
 * the top-level (first ":"-segment) category is significant for docType.
 */
export function mapGallicaTypedoc(
  typedoc: string | null | undefined,
): DocTypeCode | null {
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

/** The Gallica typedoc whose records are single periodical issues. */
const FASCICULE_TYPEDOC = "periodiques:fascicules"

/**
 * Press markers in a free-text doc_type / dc:type. "publication en série
 * imprimée" is the press label of records that carry no typedoc setSpec; the
 * catalogue SRU never has a typedoc at all. Shared by mapCatalogueDocType and
 * gallicaPageCount so the two cannot disagree on what a periodical is.
 */
export const PRESS_MARKER = /p[ée]riodique|presse|journal|publication en s[ée]rie|s[ée]rie imprim/

/**
 * The page count of a Gallica record, or null when none can be trusted.
 *
 * OAI's "Nombre total de vues" is collection-level for a periodical issue
 * (bpt6k268418n has 4 folios, OAI says 3197), so it is never a page count
 * there:
 *   - `periodiques:fascicules` → null;
 *   - no typedoc AND a press dcType (a fascicule without a setSpec) → null;
 *   - otherwise `totalViews` when it is a finite positive integer, else null.
 *
 * When the IIIF manifest was fetched, its canvas count is authoritative and
 * replaces this value (see normalizeDocument).
 */
export function gallicaPageCount(
  typedoc: string | undefined,
  totalViews: number | undefined,
  dcType: string | undefined,
): number | null {
  const normalizedTypedoc = typedoc?.trim().toLowerCase() ?? ""
  if (normalizedTypedoc === FASCICULE_TYPEDOC) return null
  if (normalizedTypedoc === "" && PRESS_MARKER.test(dcType?.toLowerCase() ?? ""))
    return null
  return typeof totalViews === "number" && Number.isInteger(totalViews) && totalViews > 0
    ? totalViews
    : null
}

/**
 * Map a Catalogue free-text doc_type string to our canonical docType.
 * Best-effort regex; returns null when nothing matches — caller falls back to
 * "other" AND must emit a structured WARN log so we can grow the map.
 */
export function mapCatalogueDocType(raw: string): string | null {
  const s = raw.toLowerCase()
  // Press is tested before the "texte"→book rule below: the catalogue SRU and
  // Gallica records without a typedoc setSpec carry only a free-text label, and
  // "publication en série imprimée" would otherwise fall through to "book".
  if (PRESS_MARKER.test(s)) return DOC_TYPE_CODE.PRESS
  if (/carte|plan/.test(s)) return DOC_TYPE_CODE.MAP
  // Scores: the manifest labels them "Musique notée" / "musique manuscrite" — no
  // "partition" token. Tested BEFORE manuscript: "musique manuscrite" contains the
  // "manuscrit" substring, but a notated-music document is a score, not a codex.
  if (/musique|partition/.test(s)) return DOC_TYPE_CODE.SCORE
  if (/manuscrit/.test(s)) return DOC_TYPE_CODE.MANUSCRIPT
  if (/image|photo|estampe/.test(s)) return DOC_TYPE_CODE.IMAGE
  if (/livre|imprim[eé]|texte|monographie/.test(s)) return DOC_TYPE_CODE.BOOK
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
export function sourceFromArk(ark: string): DocumentSource {
  const id = ark.replace(/^ark:\/\d+\//, "")
  if (id.startsWith("cb")) return DOCUMENT_SOURCE.CATALOGUE
  if (/^(bpt6k|btv1b|bd6t)/.test(id)) return DOCUMENT_SOURCE.GALLICA
  if (id.startsWith("temp-work/")) return DOCUMENT_SOURCE.DATABNF
  return DOCUMENT_SOURCE.OTHER
}

/**
 * Derive the IIIF manifest URL for a Gallica document.
 * Returns null for non-Gallica sources (no IIIF endpoint available).
 *
 * The returned URL is templated — existence is NOT verified here.
 * Caller should lazily HEAD-check on first access (slice 5+).
 */
export function iiifManifestUrl(ark: string, source: string): string | null {
  if (source !== DOCUMENT_SOURCE.GALLICA) return null
  const full = fullBnfArk(ark)
  if (full === null) return null
  return `https://gallica.bnf.fr/iiif/${full}/manifest.json`
}
