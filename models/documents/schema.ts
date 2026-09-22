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
// cb→Gallica canonicalization status (Document.canonicalStatus)
// Set on a catalogue notice (`cb…`) and driven by the BACKGROUND canonicalizer
// (lib/documents/canonicalizer.ts): `corpus_add` marks every newly-added notice
// "pending" and kicks a drain, which classifies each against its digitized
// Gallica reproduction and either swaps it (membership → Gallica doc, status
// cleared) or records why it stayed a notice. The detail panel keys its
// "promote" affordance off the terminal states: "api_error" → offer a manual
// retry; "not_digitized" → state it isn't on Gallica. A notice that WAS
// upgraded leaves no cb member, so it carries no status.
// See lib/bnf/direct.ts (classifyCanonical) and CorpusService.promoteNotice().
// ---------------------------------------------------------------------------

export const DOCUMENT_CANONICAL_STATUS = {
  /** Queued for (or mid-) background canonicalization — not yet classified. */
  PENDING: "pending",
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

/**
 * Bucket → hue for the numérisation breakdown card.
 *
 * Colours live beside their vocabulary, as DOC_TYPE/LANG/SOURCE above do, and
 * `satisfies` binds the map to the enum: adding a class without a colour is a
 * type error rather than a bar that silently renders `background: undefined`.
 */
export const INGESTION_CLASS_COLOR = {
  [INGESTION_CLASS.OCR]: "var(--info)",
  [INGESTION_CLASS.VISION]: "var(--dataset-1)",
  [INGESTION_CLASS.SANS_TEXTE]: "var(--warning)",
  [INGESTION_CLASS.NON_NUMERISE]: "var(--neutral-500)",
} satisfies Record<IngestionClass, string>

/** Whether a classification will be sent to the index (text or vision). */
export function isIngestableClass(c: IngestionClass): boolean {
  return c === INGESTION_CLASS.OCR || c === INGESTION_CLASS.VISION
}

// ---------------------------------------------------------------------------
// Indexation outcome (Document.indexedAt + Document.indexError)
//
// classifyIngestion() above is a PRE-FLIGHT predicate — "would this document be
// sent to the index". This is the OUTCOME — "what actually became of it". The
// two answer different questions and conflating them is the mistake this exists
// to stop: a corpus can be 100% `ocr` by class and still be missing a third of
// its documents because the ingest run shed them.
//
//   indexed      — indexedAt is set. The document is in the RAG index and the
//                  agent can retrieve it.
//   failed       — sent to the worker, never came back indexed, and carries a
//                  reason (rate_limited, page-fail-ratio, embed_failed, …).
//   excluded     — never sent, because it is not ingestable. Not a failure:
//                  a catalogue notice or a scan with no text layer has nothing
//                  to index.
//   not_ingested — eligible, but no ingest run has covered it yet (added after
//                  the last run, or ingestion never run on this project).
//
// The four are mutually exclusive and total: every document lands in exactly
// one, so the counts always sum to the corpus size.
//
// COUPLING: the `excluded` arm mirrors IngestService._partitionByIngestability()
// — the same class test AND the same `confident` guard, so a document reads as
// `excluded` here iff submit() would have dropped it into IngestJob.excludedArks.
// Change one and you must change the other; models/corpus/queries.ts carries the
// SQL mirror of this function and is bound by the same rule.
// ---------------------------------------------------------------------------

export const INDEXATION_OUTCOME = {
  INDEXED: "indexed",
  FAILED: "failed",
  EXCLUDED: "excluded",
  NOT_INGESTED: "not_ingested",
} as const

export type IndexationOutcome =
  (typeof INDEXATION_OUTCOME)[keyof typeof INDEXATION_OUTCOME]

/**
 * What became of this document at ingestion time.
 *
 * `digitized` is `Boolean(doc.iiifManifestUrl)`, as for {@link classifyIngestion}.
 *
 * A document indexed WITH a warning (`indexedAt` and `indexError` both set — the
 * F13 partial-transcription annotation, see IngestService.commit) is `indexed`:
 * it IS retrievable. The annotation is not lost — {@link indexationWarning}
 * surfaces it separately, because "in the index, imperfectly" is a different
 * statement from "not in the index".
 */
export function classifyOutcome(d: {
  indexedAt: Date | null
  indexError: string | null
  docType: string | null
  ocrAvailable: boolean | null
  digitized: boolean
  resolveStatus: string
}): IndexationOutcome {
  if (d.indexedAt !== null) return INDEXATION_OUTCOME.INDEXED
  if (d.indexError !== null) return INDEXATION_OUTCOME.FAILED

  // Never indexed and no error recorded — it was either never sent, or not yet
  // sent. Only an ingestability verdict we are CONFIDENT in separates the two:
  // an unresolved digitized stub might still turn out to carry OCR, so it is
  // "not yet", never "never". Mirrors _partitionByIngestability's guard.
  const cls = classifyIngestion(d)
  const confident =
    !d.digitized || d.resolveStatus === DOCUMENT_RESOLVE_STATUS.RESOLVED
  if (!isIngestableClass(cls) && confident) return INDEXATION_OUTCOME.EXCLUDED
  return INDEXATION_OUTCOME.NOT_INGESTED
}

/**
 * Bucket → hue for the indexation breakdown card. Semantic, and deliberately
 * consistent with INGESTION_CLASS_COLOR: the bucket a librarian may need to act
 * on is `--warning`, an outright failure `--destructive`, a healthy bucket
 * `--success`, and one that is merely inert (nothing to index) neutral.
 */
export const INDEXATION_OUTCOME_COLOR = {
  [INDEXATION_OUTCOME.INDEXED]: "var(--success)",
  [INDEXATION_OUTCOME.FAILED]: "var(--destructive)",
  [INDEXATION_OUTCOME.NOT_INGESTED]: "var(--warning)",
  [INDEXATION_OUTCOME.EXCLUDED]: "var(--neutral-500)",
} satisfies Record<IndexationOutcome, string>

/**
 * The reason string carried by a document that IS indexed but was flagged during
 * the run (partial transcription, low page yield). Null for every other state —
 * on a `failed` document the reason is the failure itself, not a warning, and
 * the caller reads `indexError` directly.
 */
export function indexationWarning(d: {
  indexedAt: Date | null
  indexError: string | null
}): string | null {
  return d.indexedAt !== null ? d.indexError : null
}

// ---------------------------------------------------------------------------
// Failure reasons (Document.indexError), for librarian-facing copy
//
// The worker writes a machine reason, and it is NOT a bare token: a stage
// appends its detail, so the column holds things like
// "page-fail-ratio 3/4 > 0.5" or "embed_failed_after_retries: 429". The stable
// part is the LEADING token — everything before the first space or colon — so
// that is what we key on. Matching the whole string would silently fall through
// to the raw text for every reason that carries detail, which is most of them.
//
// The vocabulary is open (worker-v2/src/stages/* adds to it freely), so an
// unrecognised token falls back to the raw string rather than being dropped: a
// reason we cannot name is still worth showing a librarian, and swallowing it
// would hide an entire failure mode. Callers keep the raw string available
// regardless — the label is a summary, not a replacement.
// ---------------------------------------------------------------------------

/**
 * Worker reason token → i18n key suffix under `corpus.indexation.reasons`.
 *
 * Grouped by what the librarian needs to know (was there text to index? did the
 * BnF throttle us? did transcription fail?) rather than by which pipeline stage
 * raised it — `ocr_submit` vs `ocr_poll` is our plumbing, not their problem.
 */
const INDEXATION_REASON_KEY: Record<string, string> = {
  // Nothing to index — the document carried no usable text or images.
  assemble_no_text: "noText",
  describe_no_pages: "noText",
  ocr_submit_no_images: "noText",
  embed_no_pages: "noText",
  // Transcription did not complete.
  ocr_timeout: "ocrFailed",
  ocr_batch_failed: "ocrFailed",
  ocr_submit_failed_after_retries: "ocrFailed",
  ocr_poll_failed_after_retries: "ocrFailed",
  describe_failed_after_retries: "ocrFailed",
  assemble_failed_after_retries: "ocrFailed",
  // Too many pages of the document failed for the result to be trustworthy.
  "page-fail-ratio": "partialPages",
  // BnF throttling shed the document.
  rate_limited: "rateLimited",
  // Indexing itself failed after the content was in hand.
  embed_failed_after_retries: "indexFailed",
  register_missing_artifacts: "indexFailed",
}

/**
 * The i18n key suffix for a raw `indexError` string, or null when the reason is
 * one we have no copy for — the caller then shows the raw string, which is the
 * honest fallback.
 */
export function indexationReasonKey(reason: string): string | null {
  const token = reason.split(/[\s:]/, 1)[0]
  return INDEXATION_REASON_KEY[token] ?? null
}

// ---------------------------------------------------------------------------
// Script eligibility for paid fallback OCR
// ---------------------------------------------------------------------------
// Mistral OCR transcribes Latin-script historical print well, but mangles
// non-Latin scripts (verified: 16th-c. Greek came back as garbled Greek letters
// — wrong words, broken accents). We don't offer (or charge for) paid OCR on
// scripts we can't faithfully transcribe. The decision keys on Document.lang,
// which BnF populates with ISO 639 codes; the non-Latin ones present in the
// corpus are grc / ar / he, plus the broader set below for completeness.
//
// A null/unknown lang is treated as ELIGIBLE (presumed Latin): the BnF print
// corpus is French/Latin-dominant and null means "not yet resolved", not
// "non-Latin" — the genuinely non-Latin docs carry an explicit code. The
// per-ingestion confirmation still gives the librarian the final say.

/** ISO 639-1/2/3 codes whose primary script is NOT Latin. Lowercased. */
const NON_LATIN_SCRIPT_LANGS = new Set<string>([
  // Greek
  "el", "ell", "gre", "grc",
  // Hebrew / Yiddish
  "he", "heb", "iw", "yi", "yid",
  // Arabic / Persian / Urdu / Syriac
  "ar", "ara", "fa", "fas", "per", "ur", "urd", "syr", "syc",
  // CJK
  "zh", "zho", "chi", "ja", "jpn", "ko", "kor",
  // Cyrillic
  "ru", "rus", "uk", "ukr", "be", "bel", "bg", "bul", "mk", "mkd",
  "sr", "srp",
  // Caucasian / South & SE Asian / others
  "hy", "hye", "arm", "ka", "kat", "geo", "th", "tha",
  "hi", "hin", "bn", "ben", "ta", "tam", "am", "amh",
  "sa", "san", "cop",
])

/**
 * Whether a document's language is written in Latin script — i.e. whether paid
 * fallback OCR can faithfully transcribe it. Non-Latin codes return false;
 * null/unknown returns true (presumed Latin — see the note above).
 */
export function isLatinScriptLang(lang: string | null | undefined): boolean {
  if (!lang) return true
  return !NON_LATIN_SCRIPT_LANGS.has(lang.trim().toLowerCase())
}
