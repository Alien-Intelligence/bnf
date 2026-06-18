// models/documents/schema.ts
// Open vocabulary maps for document facets (docType, lang, source).
// These drive the facet UI and badge rendering.
//
// Vocabularies are "open" per design/docs/03 — new codes can appear without
// a schema migration. Labels are i18n key suffixes (full wiring in commit #11);
// colors are Tailwind utility-class strings for the badge component.
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
// Per design/docs/03: press|image|estampe|book|map|manuscript|enlum|charte|…
// ---------------------------------------------------------------------------

export const DOC_TYPE: Record<string, VocabEntry> = {
  press: { label: "press", color: "bg-blue-100 text-blue-900" },
  book: { label: "book", color: "bg-amber-100 text-amber-900" },
  image: { label: "image", color: "bg-purple-100 text-purple-900" },
  estampe: { label: "estampe", color: "bg-rose-100 text-rose-900" },
  map: { label: "map", color: "bg-green-100 text-green-900" },
  manuscript: { label: "manuscript", color: "bg-yellow-100 text-yellow-900" },
  enlum: { label: "enlum", color: "bg-orange-100 text-orange-900" },
  charte: { label: "charte", color: "bg-teal-100 text-teal-900" },
} as const

// ---------------------------------------------------------------------------
// Language vocabulary (lang column)
// BCP-47-ish codes as stored by BnF MCP; open set.
// ---------------------------------------------------------------------------

export const LANG: Record<string, VocabEntry> = {
  fr: { label: "fr", color: "bg-indigo-100 text-indigo-900" },
  en: { label: "en", color: "bg-sky-100 text-sky-900" },
  la: { label: "la", color: "bg-stone-100 text-stone-900" },
  de: { label: "de", color: "bg-lime-100 text-lime-900" },
  es: { label: "es", color: "bg-red-100 text-red-900" },
  it: { label: "it", color: "bg-emerald-100 text-emerald-900" },
} as const

// ---------------------------------------------------------------------------
// Source vocabulary (source column)
// Open: new sources arrive as the MCP resolves more documents.
// ---------------------------------------------------------------------------

export const SOURCE: Record<string, VocabEntry> = {
  gallica: { label: "gallica", color: "bg-cyan-100 text-cyan-900" },
  retronews: { label: "retronews", color: "bg-violet-100 text-violet-900" },
  databnf: { label: "databnf", color: "bg-fuchsia-100 text-fuchsia-900" },
  arsenal: { label: "arsenal", color: "bg-pink-100 text-pink-900" },
  archives37: { label: "archives37", color: "bg-slate-100 text-slate-900" },
} as const
