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
// Document type vocabulary (doc_type column)
// Canonical codes produced by lib/mcp/normalize.ts mapDocType().
// "open": unknown codes from future MCP output fall through to badge rendering
// with the raw code as label — they will not crash the UI.
// ---------------------------------------------------------------------------

export const DOC_TYPE: Record<string, VocabEntry> = {
  // Core codes observed via Gallica enum and Catalogue free-text mapping
  press: { label: "press", color: "bg-blue-100 text-blue-900" },
  book: { label: "book", color: "bg-amber-100 text-amber-900" },
  image: { label: "image", color: "bg-purple-100 text-purple-900" },
  map: { label: "map", color: "bg-green-100 text-green-900" },
  manuscript: { label: "manuscript", color: "bg-yellow-100 text-yellow-900" },
  // Gallica-enum-specific codes added in slice 2 (real MCP output observed)
  score: { label: "score", color: "bg-purple-100 text-purple-900" },
  video: { label: "video", color: "bg-rose-100 text-rose-900" },
  audio: { label: "audio", color: "bg-cyan-100 text-cyan-900" },
  poster: { label: "poster", color: "bg-orange-100 text-orange-900" },
  // Low-priority codes from older design-doc spec; present in some Catalogue records
  estampe: { label: "estampe", color: "bg-rose-100 text-rose-900" },
  enlum: { label: "enlum", color: "bg-orange-100 text-orange-900" },
  charte: { label: "charte", color: "bg-teal-100 text-teal-900" },
  // Catch-all for Catalogue free-text types that do not match any known pattern
  other: { label: "other", color: "bg-gray-100 text-gray-900" },
} as const

// ---------------------------------------------------------------------------
// Language vocabulary (lang column)
// ISO 639-1 codes as normalised by lib/mcp/normalize.ts (MARC → ISO map).
// Open set: unknown codes are stored as-is; extend the MARC map on observation.
// ---------------------------------------------------------------------------

export const LANG: Record<string, VocabEntry> = {
  fr: { label: "fr", color: "bg-indigo-100 text-indigo-900" },
  en: { label: "en", color: "bg-sky-100 text-sky-900" },
  la: { label: "la", color: "bg-stone-100 text-stone-900" },
  de: { label: "de", color: "bg-lime-100 text-lime-900" },
  it: { label: "it", color: "bg-emerald-100 text-emerald-900" },
  es: { label: "es", color: "bg-red-100 text-red-900" },
  pt: { label: "pt", color: "bg-orange-100 text-orange-900" },
  nl: { label: "nl", color: "bg-amber-100 text-amber-900" },
  grc: { label: "grc", color: "bg-violet-100 text-violet-900" },
  el: { label: "el", color: "bg-purple-100 text-purple-900" },
  ru: { label: "ru", color: "bg-rose-100 text-rose-900" },
  ja: { label: "ja", color: "bg-pink-100 text-pink-900" },
  zh: { label: "zh", color: "bg-fuchsia-100 text-fuchsia-900" },
  ar: { label: "ar", color: "bg-teal-100 text-teal-900" },
  he: { label: "he", color: "bg-cyan-100 text-cyan-900" },
} as const

// ---------------------------------------------------------------------------
// Source vocabulary (source column)
// Derived by sourceFromArk() in lib/mcp/normalize.ts from the ARK identifier
// prefix. Only sources observed in real MCP output are listed here.
// ---------------------------------------------------------------------------

export const SOURCE: Record<string, VocabEntry> = {
  gallica: { label: "gallica", color: "bg-cyan-100 text-cyan-900" },
  catalogue: { label: "catalogue", color: "bg-violet-100 text-violet-900" },
  databnf: { label: "databnf", color: "bg-fuchsia-100 text-fuchsia-900" },
  other: { label: "other", color: "bg-gray-100 text-gray-900" },
} as const
