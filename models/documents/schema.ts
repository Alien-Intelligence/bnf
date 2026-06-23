// models/documents/schema.ts
// Open vocabulary maps for document facets (docType, lang, source).
// These drive the facet UI and badge rendering.
//
// Vocabularies are "open" per design/docs/03 — new codes can appear without
// a schema migration. Labels are i18n key suffixes; components use
// useTranslations("corpus.docTypes") and look up by code.
// Colors are Tailwind utility-class strings for the badge component.
//
// Observed sources derived from real MCP output (research note §6):
//   gallica   — Gallica digital library (ARK prefix: bpt6k, btv1b, bd6t)
//   catalogue — BnF Catalogue bibliographic notices (ARK prefix: cb)
//   databnf   — data.bnf.fr semantic URIs (ARK prefix: temp-work/)
//   other     — everything else
//
// Codes removed vs. slice 1 design-doc speculation:
//   retronews, arsenal, archives37 — not observed in any real MCP return.
//   Do not restore without a concrete ARK example that maps to them.
//
// No imports from other model directories — schema.ts is the foundation layer.

/** One entry in a facet vocabulary map. */
export type VocabEntry = {
  /** i18n key suffix used to look up the display label. */
  label: string
  /** Tailwind class string for the badge: background + text color. */
  color: string
}

// ---------------------------------------------------------------------------
// Background metadata-resolution lifecycle (Document.resolveStatus)
// A freshly-added ARK is inserted as a "stub" (pending); the drainer resolves
// it via the BnF MCP (resolved) or marks it failed after the retry ceiling.
// See lib/documents/resolver.ts and playbook-adjacent plan async-resolve.
// ---------------------------------------------------------------------------

export const DOCUMENT_RESOLVE_STATUS = {
  PENDING: "pending",
  RESOLVED: "resolved",
  FAILED: "failed",
} as const

export type DocumentResolveStatus =
  (typeof DOCUMENT_RESOLVE_STATUS)[keyof typeof DOCUMENT_RESOLVE_STATUS]

// ---------------------------------------------------------------------------
// cb→Gallica canonicalization outcome (Document.canonicalStatus)
// Recorded on a catalogue notice that stayed a notice after the add-time
// canonicalization pass. Drives the detail panel's "promote" affordance:
// "api_error" → offer a manual retry; "not_digitized" → state it isn't on
// Gallica. A notice that WAS upgraded leaves no cb row, so it carries neither.
// See lib/bnf/direct.ts (classifyCanonical) and CorpusService.promoteNotice().
// ---------------------------------------------------------------------------

export const DOCUMENT_CANONICAL_STATUS = {
  /** Last pass failed transiently (BnF API flakiness) — a retry may succeed. */
  API_ERROR: "api_error",
  /** Pass ran cleanly; no Gallica reproduction exists — catalogue-only notice. */
  NOT_DIGITIZED: "not_digitized",
} as const

export type DocumentCanonicalStatus =
  (typeof DOCUMENT_CANONICAL_STATUS)[keyof typeof DOCUMENT_CANONICAL_STATUS]

// ---------------------------------------------------------------------------
// Document type vocabulary (doc_type column)
// Canonical codes produced by lib/mcp/normalize.ts mapDocType().
// "open": unknown codes from future MCP output fall through to badge rendering
// with the raw code as label — they will not crash the UI.
// ---------------------------------------------------------------------------

// Colors are dark-first dataset tints (bg-{hue}/15 + text-{hue}); the hue
// mapping follows the prototype TYPES map (design/.dc.html lines 917-925).
export const DOC_TYPE: Record<string, VocabEntry> = {
  // Core codes observed via Gallica enum and Catalogue free-text mapping
  press: { label: "press", color: "bg-dataset-3/15 text-dataset-3" },
  book: { label: "book", color: "bg-dataset-2/15 text-dataset-2" },
  image: { label: "image", color: "bg-dataset-1/15 text-dataset-1" },
  map: { label: "map", color: "bg-dataset-4/15 text-dataset-4" },
  manuscript: { label: "manuscript", color: "bg-dataset-7/15 text-dataset-7" },
  // Gallica-enum-specific codes added in slice 2 (real MCP output observed)
  score: { label: "score", color: "bg-dataset-2/15 text-dataset-2" },
  video: { label: "video", color: "bg-dataset-5/15 text-dataset-5" },
  audio: { label: "audio", color: "bg-dataset-3/15 text-dataset-3" },
  poster: { label: "poster", color: "bg-dataset-6/15 text-dataset-6" },
  // Low-priority codes from older design-doc spec; present in some Catalogue records
  estampe: { label: "estampe", color: "bg-dataset-6/15 text-dataset-6" },
  enlum: { label: "enlum", color: "bg-dataset-1/15 text-dataset-1" },
  charte: { label: "charte", color: "bg-dataset-4/15 text-dataset-4" },
  // Catch-all for Catalogue free-text types that do not match any known pattern
  other: { label: "other", color: "bg-muted text-muted-foreground" },
} as const

// ---------------------------------------------------------------------------
// Language vocabulary (lang column)
// ISO 639-1 codes as normalised by lib/mcp/normalize.ts (MARC → ISO map).
// Open set: unknown codes are stored as-is; extend the MARC map on observation.
// ---------------------------------------------------------------------------

// Languages render as a subtle neutral chip (the prototype keeps language a
// secondary signal; type carries the color). Uniform, dark-first.
const LANG_CHIP = "bg-secondary text-muted-foreground"
export const LANG: Record<string, VocabEntry> = {
  fr: { label: "fr", color: LANG_CHIP },
  en: { label: "en", color: LANG_CHIP },
  la: { label: "la", color: LANG_CHIP },
  de: { label: "de", color: LANG_CHIP },
  it: { label: "it", color: LANG_CHIP },
  es: { label: "es", color: LANG_CHIP },
  pt: { label: "pt", color: LANG_CHIP },
  nl: { label: "nl", color: LANG_CHIP },
  grc: { label: "grc", color: LANG_CHIP },
  el: { label: "el", color: LANG_CHIP },
  ru: { label: "ru", color: LANG_CHIP },
  ja: { label: "ja", color: LANG_CHIP },
  zh: { label: "zh", color: LANG_CHIP },
  ar: { label: "ar", color: LANG_CHIP },
  he: { label: "he", color: LANG_CHIP },
} as const

// ---------------------------------------------------------------------------
// Source vocabulary (source column)
// Derived by sourceFromArk() in lib/mcp/normalize.ts from the ARK identifier
// prefix. Only sources observed in real MCP output are listed here.
// ---------------------------------------------------------------------------

export const SOURCE: Record<string, VocabEntry> = {
  gallica: { label: "gallica", color: "bg-dataset-3/15 text-dataset-3" },
  catalogue: { label: "catalogue", color: "bg-dataset-2/15 text-dataset-2" },
  databnf: { label: "databnf", color: "bg-dataset-1/15 text-dataset-1" },
  other: { label: "other", color: "bg-muted text-muted-foreground" },
} as const

// ---------------------------------------------------------------------------
// Ingestion classification (numérisation & océrisation)
// Mirrors the ingestion pipeline contract in design/docs/07: a document is
// ingestable iff it carries text the pipeline can index. Derived from real
// signals — digitization (a Gallica IIIF manifest), OCR availability
// (ocr_available from the MCP), and doc type — NOT a per-type heuristic.
//
//   ocr          — has an OCR text layer → ingested via its text
//   vision       — digitized image-like type without OCR → described by a
//                  vision model (Gemma), then ingested
//   sans_texte   — digitized text-like type without OCR → NOT ingested
//                  (this pipeline does not run fallback OCR)
//   non_numerise — not digitized at all → NOT ingested
// ---------------------------------------------------------------------------

export const INGESTION_CLASS = {
  OCR: "ocr",
  VISION: "vision",
  SANS_TEXTE: "sans_texte",
  NON_NUMERISE: "non_numerise",
} as const

export type IngestionClass =
  (typeof INGESTION_CLASS)[keyof typeof INGESTION_CLASS]

/**
 * Doc types whose primary content is a single image (no native text), so an
 * OCR-less copy is still ingestable via vision description rather than dropped.
 * Exported so the snapshot query can build the equivalent SQL predicate when
 * filtering by ingestion class (keep the two in sync — one source of truth).
 */
export const INGESTION_IMAGE_LIKE_TYPES = [
  "image",
  "poster",
  "estampe",
  "map",
  "enlum",
  "video",
  "audio",
] as const

const IMAGE_LIKE_TYPES = new Set<string>(INGESTION_IMAGE_LIKE_TYPES)

/**
 * Classify a resolved document for the numérisation/ingestion buckets.
 *
 * `digitized` is whether the document has a Gallica IIIF surface — callers pass
 * `Boolean(doc.iiifManifestUrl)` (manifests are Gallica-only; see
 * lib/mcp/vocab.ts iiifManifestUrl).
 */
export function classifyIngestion(d: {
  docType: string | null
  ocrAvailable: boolean | null
  digitized: boolean
}): IngestionClass {
  if (!d.digitized) return INGESTION_CLASS.NON_NUMERISE
  if (d.ocrAvailable === true) return INGESTION_CLASS.OCR
  if (d.docType !== null && IMAGE_LIKE_TYPES.has(d.docType)) {
    return INGESTION_CLASS.VISION
  }
  return INGESTION_CLASS.SANS_TEXTE
}

/** Whether a classification will be sent to the index (text or vision). */
export function isIngestableClass(c: IngestionClass): boolean {
  return c === INGESTION_CLASS.OCR || c === INGESTION_CLASS.VISION
}
