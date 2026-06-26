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

/** Reduced catalogue metadata, from OAI-PMH (text lane) or the IIIF manifest (image fallback). */
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
  pageCount: number | null;
  iiifManifestUrl: string | null;
  lang: string | null;
  raw: Record<string, unknown>;
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

/** One folio's ALTO outcome. `empty` = a legitimately text-less page (ALTO 404). */
export interface AltoFolio {
  text: string;
  empty: boolean;
}

export interface BnfClient {
  /** OAI-PMH metadata (manifest fallback inside). Throws Permanent on 404/bad-ark/notice. */
  getDocumentInfo(ark: string): Promise<BnfDocInfo>;
  /** IIIF v3 manifest → canvas list. Throws Permanent on terminal manifest failure. */
  getManifest(ark: string, maxCanvases: number): Promise<Manifest>;
  /** Fetch + parse ONE folio's ALTO text. 404 → `{text:"", empty:true}` (not an error). */
  fetchAltoFolio(ark: string, ordre: number): Promise<AltoFolio>;
  /** Fetch ONE folio's IIIF image bytes (JPEG). */
  fetchImageFolio(ark: string, ordre: number, size?: string): Promise<Buffer>;
}
