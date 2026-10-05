/**
 * The BnF adapter contract — the narrow seam between the pipeline stages and the
 * (ported, battle-tested) V1 BnF logic. Stages depend ONLY on this interface, so
 * the heavy HTTP/parsing client can be swapped for a fake in tests and the live
 * concrete client (src/bnf/client.ts) is the only thing that touches the broker.
 *
 * Everything here is per-document or per-folio — there is no whole-doc fetch. The
 * fetch stage pulls ONE folio at a time (the 300/min binding constraint), which
 * is the structural fix over V1's per-doc monolith.
 *
 * Methods throw `TransientBnfError` (retry) or `PermanentBnfError` (terminal) from
 * ./errors — the stage base coerces a throw into a non-terminal fail, and the
 * concrete stages translate Permanent into a terminal fail / skip.
 */

/**
 * Where a BnfDocInfo came from — `raw.source` of every cached `meta/<slug>.json`
 * blob. The IIIF manifest is the primary path; OAI-PMH the fallback for the rare
 * manifest-less ARK (client.ts). One definition: the client writes it, the
 * cached-blob normalizer (doc-info.ts) reads it.
 */
export const DOC_INFO_SOURCE = {
  IIIF_MANIFEST: "iiif_manifest",
  OAI_PMH: "oai_pmh",
} as const;
export type DocInfoSource = (typeof DOC_INFO_SOURCE)[keyof typeof DOC_INFO_SOURCE];

/** Reduced catalogue metadata, from the IIIF manifest (primary) or OAI-PMH (fallback). */
export interface BnfDocInfo {
  ark: string;
  title: string | null;
  creator: string | null;
  date: string | null;
  docType: string | null;
  /** Gallica typedoc subcategory ("fascicules", "estampes", …); finer than docType. */
  subtype: string | null;
  /** True when BnF announces a text layer ("Avec mode texte") → text lane. */
  ocrAvailable: boolean;
  /**
   * The manifest's "Taux OCR" / 100, in [0, 1] — the document-level OCR
   * quality BnF publishes. Null when BnF publishes none (the OAI-PMH fallback
   * carries no Taux OCR; image documents have no OCR) OR when the published
   * value cannot be read (unparseable or above 100 %) — that case is logged
   * where the value enters the worker (`taux_ocr_unusable`). Distinct from
   * `ocrAvailable`, which is only the PRESENCE of the row (lane routing).
   */
  ocrRate: number | null;
  pageCount: number | null;
  iiifManifestUrl: string | null;
  lang: string | null;
  /** The source record, as fetched; `source` says which one (DocInfoSource). */
  raw: Record<string, unknown> & { source: DocInfoSource };
}

export interface ManifestCanvas {
  ordre: number;
  label: string | null;
  width: number | null;
  height: number | null;
}

export interface Manifest {
  title: string | null;
  metadata: Array<{ label: string; value: string }>;
  totalPages: number;
  canvases: ManifestCanvas[];
}

/**
 * The per-folio word-confidence sidecar persisted at keys.altoQuality — the WC
 * statistics parsed from the ALTO XML, which the `alto` text cache does not keep.
 * `v` is the shape version; bump it if a field changes meaning.
 */
export interface AltoFolioQuality {
  v: 1;
  /** Words (non-empty <String CONTENT>) on the folio; 0 for an empty folio. */
  wordCount: number;
  /** Words carrying a valid WC in [0, 1]. */
  scoredWordCount: number;
  /** Mean WC over the scored words, 4 decimals; null when none is scored. */
  meanWc: number | null;
}

/**
 * One folio's ALTO outcome. `empty` = a legitimately text-less page (ALTO 404 or
 * no words). `quality` is always present — an empty folio reports
 * `{wordCount: 0, meanWc: null}`. `invalidWcCount` is the number of WC
 * attributes that were present but unusable (logged by the stage, never stored).
 */
export interface AltoFolio {
  text: string;
  empty: boolean;
  quality: AltoFolioQuality;
  invalidWcCount: number;
}

export interface BnfClient {
  /**
   * IIIF v3 manifest → canvas list + totalPages. This is the metadata stage's
   * PRIMARY metadata source too (via the pure `docInfoFromManifest` in
   * client.ts) — there is no separate "get metadata" call. Throws Permanent on
   * terminal manifest failure, in which case the caller falls back to
   * `getDocumentInfoViaOai`.
   */
  getManifest(ark: string, maxCanvases: number): Promise<Manifest>;
  /**
   * Fallback metadata path: ungated OAI-PMH (oai.bnf.fr). Called only when the
   * manifest is permanently unavailable. Throws Permanent on 404/bad-ark/notice.
   */
  getDocumentInfoViaOai(ark: string): Promise<BnfDocInfo>;
  /**
   * Fetch + parse ONE folio's ALTO: text + word-confidence quality. 404 → the
   * empty folio (`text:""`, `empty:true`, `quality.wordCount:0`), not an error.
   * A truncated or non-ALTO body throws Transient("alto_parse_failed").
   */
  fetchAltoFolio(ark: string, ordre: number): Promise<AltoFolio>;
  /** Fetch ONE folio's IIIF image bytes (JPEG). */
  fetchImageFolio(ark: string, ordre: number, size?: string): Promise<Buffer>;
}
