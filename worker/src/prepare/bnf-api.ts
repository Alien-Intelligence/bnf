/**
 * Direct Gallica HTTP client. Replaces the BnF MCP layer for the ingest
 * worker — no JSON-RPC, no session state, no envelope unwrapping.
 *
 * Public interface mirrors the old `BnfMcp` so the rest of the prepare
 * pipeline didn't have to change:
 *
 *   - getDocumentInfo(ark)   → OAIRecord (XML)        → BnfDocInfo
 *   - getDocumentText(ark)   → Pagination + ALTO (XML) → { pages, page_count }
 *   - getManifest(ark)       → IIIF Presentation v2 (JSON)
 *   - getImageUrl(ark)       → pure URL computation
 *   - close()                → no-op
 *
 * Every HTTP call is wrapped in `withBnfRetry`. Status codes are classified
 * into TransientBnfError / PermanentBnfError so the runner can decide whether
 * to rethrow (let pg-boss retry) or mark the doc-job failed terminally.
 */
import { request } from "undici";
import { XMLParser } from "fast-xml-parser";

import type { BnfDocInfo } from "../types.js";
import { arkToSlug } from "../slug.js";

import { PermanentBnfError, TransientBnfError } from "./errors.js";
import { gallicaRelayUrl, relayGet } from "./gallica-relay.js";
import { altoRateLimit, gallicaRateLimit, type TokenBucket } from "./rate-limiter.js";
import { withBnfRetry } from "./retry.js";
import { fetchViewerOcr } from "./viewer-ocr.js";

const USER_AGENT = "bnf-ingest/0.1 (leo@alien.club)";
const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 15_000;
const GALLICA = "https://gallica.bnf.fr";

/** Same shape extract.ts expects from `getDocumentText`. */
export interface RawDocText {
  pages: Array<{ ordre: number; text: string }>;
  page_count: number;
  /** Compatibility: the old MCP shape sometimes carried `text`; never set here. */
  text?: string;
}

export interface ManifestCanvas {
  ordre: number;
  label: string | null;
  width: number | null;
  height: number | null;
  imageServiceUrl: string | null;
}

export interface Manifest {
  title: string | null;
  /** Flattened IIIF `metadata[]` (label → value), used as the OAIRecord fallback. */
  metadata: Array<{ label: string; value: string }>;
  totalPages: number;
  canvases: ManifestCanvas[];
}

// ---------------------------------------------------------------------------
// XML parsers — single instance each, configured once.
// ---------------------------------------------------------------------------

/** OAIRecord parser: preserves attributes so we can pick dc:type[xml:lang="fre"]. */
const oaiParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // We want repeated dc:* tags to come through as arrays; the parser handles
  // single-vs-array per element but tagging the common repeating tags as
  // always-array keeps the consumer simple.
  isArray: (name) =>
    name === "dc:type" ||
    name === "dc:creator" ||
    name === "dc:contributor" ||
    name === "dc:subject" ||
    name === "dc:language" ||
    name === "dc:title" ||
    name === "dc:format" ||
    name === "dc:description" ||
    name === "setSpec",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** ALTO parser: preserves @_CONTENT on String tags and TextLine structure. */
const altoParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    name === "String" ||
    name === "TextLine" ||
    name === "TextBlock" ||
    name === "Page",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** Pagination parser: each <page> is its own element with <ordre>. */
const paginationParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "page",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface FetchTextResult {
  status: number;
  body: string;
}

async function fetchText(
  url: string,
  opts: { timeoutMs?: number; accept?: string; rateLimiter?: TokenBucket } = {},
): Promise<FetchTextResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Acquire BEFORE arming the timeout — waiting on the budget must not count
  // against the per-request timeout, otherwise a queued request would always
  // abort before sending. Defaults to the GENERAL limiter; the ALTO path
  // passes the strict one.
  await (opts.rateLimiter ?? gallicaRateLimit).acquire();
  // Demo stopgap: when a relay is configured, borrow a browser handshake so
  // Cloudflare's bot-fight-mode doesn't reject our client fingerprint. The
  // relay mirrors the upstream status, so classification downstream is identical.
  if (gallicaRelayUrl()) {
    try {
      const { status, bytes } = await relayGet(
        url,
        opts.accept ?? "application/xml, text/xml, */*",
        timeoutMs,
      );
      return { status, body: bytes.toString("utf8") };
    } catch (err) {
      throw new TransientBnfError("network", {
        hint: `${url}: relay ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await request(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: opts.accept ?? "application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    const body = await res.body.text();
    return { status: res.statusCode, body };
  } catch (err) {
    // Normalize abort + network errors into TransientBnfError so callers
    // get a consistent classification.
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (
        err.name === "AbortError" ||
        msg.includes("aborted") ||
        msg.includes("timeout")
      ) {
        throw new TransientBnfError("timeout", { hint: url });
      }
      if (
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("socket hang up") ||
        msg.includes("fetch failed") ||
        msg.includes("other side closed")
      ) {
        throw new TransientBnfError("network", { hint: `${url}: ${err.message}` });
      }
    }
    throw new TransientBnfError("network", {
      hint: `${url}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify HTTP non-2xx responses into Transient vs Permanent errors.
 * 200/2xx fall through (caller handles parsing).
 */
function classifyStatus(
  status: number,
  body: string,
  url: string,
): TransientBnfError | PermanentBnfError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404) {
    return new PermanentBnfError("not_found", { status, hint: url });
  }
  if (status === 400) {
    // Gallica returns 400 when the ARK is malformed or not in the catalogue.
    return new PermanentBnfError("bad_ark", {
      status,
      hint: `${url}: ${body.slice(0, 200)}`,
    });
  }
  if (status === 429) {
    return new TransientBnfError("rate_limited", {
      status,
      is429: true,
      hint: url,
    });
  }
  if (status >= 500) {
    return new TransientBnfError("server_error", { status, hint: url });
  }
  // Everything else (other 4xx) — Gallica's behavior here is inconsistent;
  // treat as transient so the retry policy can sort it out. The runner's
  // final-attempt logic will mark it failed if it never recovers.
  return new TransientBnfError(`http_${status}`, {
    status,
    hint: `${url}: ${body.slice(0, 200)}`,
  });
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function firstOrNull<T>(v: T | T[] | undefined | null): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? (v[0] ?? null) : null;
  return v;
}

/**
 * Pull a text value out of a possibly-attribute-decorated XML element.
 * fast-xml-parser yields either a bare string or `{ "#text": "...", "@_lang": "..." }`.
 */
function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t.trim() || null;
  }
  return null;
}

/**
 * Pick the language-tagged dc:type if one exists (xml:lang="fre"), else the
 * first entry. Gallica often emits two: a short code and a French label.
 */
function pickDcType(types: unknown): string | null {
  if (!Array.isArray(types)) return textOf(types);
  for (const t of types) {
    if (
      t &&
      typeof t === "object" &&
      ((t as Record<string, unknown>)["@_xml:lang"] === "fre" ||
        (t as Record<string, unknown>)["@_lang"] === "fre")
    ) {
      const v = textOf(t);
      if (v) return v;
    }
  }
  return textOf(types[0]);
}

function pickFirstLanguage(langs: unknown): string | null {
  if (!Array.isArray(langs)) return textOf(langs);
  for (const l of langs) {
    const v = textOf(l);
    if (v) return v;
  }
  return null;
}

/**
 * Gallica encodes the total view count inside a dc:format string like
 * "Nombre total de vues :  12". When the canonical field is missing this is
 * the only way to recover the page count without a second Pagination call.
 */
function extractPageCountFromFormat(formats: unknown): number | null {
  const list = Array.isArray(formats) ? formats : formats != null ? [formats] : [];
  for (const f of list) {
    const s = textOf(f);
    if (!s) continue;
    const m = /Nombre\s+total\s+de\s+vues\s*:\s*(\d+)/i.exec(s);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// BnfApi — public interface
// ---------------------------------------------------------------------------

export class BnfApi {
  // No connection / session — every method is a fresh HTTP call.

  async close(): Promise<void> {
    // No-op: nothing to clean up.
  }

  // ---------------- getDocumentInfo ----------------

  async getDocumentInfo(ark: string): Promise<BnfDocInfo> {
    const canonicalArk = ensureCanonicalArk(ark);
    // Fail fast on catalogue notices. `cb*` ARKs are bibliographic/authority
    // records, not digitized documents — they have no pages, so Pagination and
    // the viewer endpoint ECONNRESET on every call. Without this guard the
    // runner reads those resets as transient and retries the doc-job six times
    // over ~an hour before giving up, which is exactly what wedged a demo run.
    // The prefix is deterministic, so this is a permanent classification — NOT
    // a generic "network error → permanent" rule (real Gallica throttling on a
    // digitized ARK must still retry).
    if (isCatalogueNotice(canonicalArk)) {
      throw new PermanentBnfError("not_digitized", {
        hint: `${canonicalArk}: catalogue notice (cb*), not a digitized document`,
      });
    }
    try {
      return await this.getDocumentInfoFromOAIRecord(canonicalArk);
    } catch (e) {
      // OAIRecord is incomplete: many ARKs that are perfectly viewable on
      // Gallica IIIF (Cartes & Plans, Estampes, specialist series) return a
      // 400 / empty envelope from /services/OAIRecord. The IIIF manifest is
      // the universal metadata fallback — derive title/creator/date from
      // `manifest.metadata[]` and route the doc through the image (Holo) path,
      // since these are iconographic and carry no OCR. Only a *permanent*
      // OAIRecord failure triggers the fallback; transient errors propagate so
      // pg-boss retries the whole doc-job.
      if (e instanceof PermanentBnfError) {
        return await this.getDocumentInfoFromManifest(canonicalArk, e);
      }
      throw e;
    }
  }

  private async getDocumentInfoFromOAIRecord(
    canonicalArk: string,
  ): Promise<BnfDocInfo> {
    const url = `${GALLICA}/services/OAIRecord?ark=${encodeURIComponent(canonicalArk)}`;

    const xml = await withBnfRetry(
      async () => {
        const { status, body } = await fetchText(url);
        const err = classifyStatus(status, body, url);
        if (err) throw err;
        return body;
      },
      { label: "OAIRecord" },
    );

    let parsed: unknown;
    try {
      parsed = oaiParser.parse(xml);
    } catch (e) {
      throw new TransientBnfError("xml_parse_failed", {
        hint: `OAIRecord: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const root = (parsed as Record<string, unknown>).results;
    if (!root || typeof root !== "object") {
      throw new PermanentBnfError("not_found", {
        hint: `OAIRecord returned no <results> for ${canonicalArk}`,
      });
    }
    const r = root as Record<string, unknown>;

    // Navigate: results → notice → record → metadata → oai_dc:dc → dc:*
    // Gallica's OAI response is wrapped in a record/metadata/oai_dc:dc envelope.
    // Some legacy responses elide one or two of these layers; we drill through
    // whatever exists.
    const notice = r.notice as Record<string, unknown> | undefined;
    if (!notice || typeof notice !== "object") {
      throw new PermanentBnfError("not_found", {
        hint: `OAIRecord <notice> missing for ${canonicalArk}`,
      });
    }
    const record =
      (notice.record as Record<string, unknown> | undefined) ?? notice;
    const metadata =
      (record.metadata as Record<string, unknown> | undefined) ?? record;
    const dc =
      (metadata["oai_dc:dc"] as Record<string, unknown> | undefined) ??
      (metadata as Record<string, unknown>);
    if (!dc || typeof dc !== "object") {
      throw new PermanentBnfError("not_found", {
        hint: `OAIRecord dc envelope missing for ${canonicalArk}`,
      });
    }

    const title = textOf(firstOrNull(dc["dc:title"]));
    const creator = textOf(firstOrNull(dc["dc:creator"]));
    const date = textOf(dc["dc:date"]);
    const docType = pickDcType(dc["dc:type"]);
    const lang = pickFirstLanguage(dc["dc:language"]);

    // Gallica doesn't emit a dedicated <ocr> element. OCR availability is
    // signaled by `<mode_indexation>text</mode_indexation>` at the results
    // level, with `<dc:description>Avec mode texte</dc:description>` as a
    // secondary hint. Either is sufficient.
    const modeIndexation = textOf(r.mode_indexation);
    const dcDescription = textOf(firstOrNull(dc["dc:description"]));
    const ocrFromMode =
      modeIndexation != null && modeIndexation.toLowerCase().includes("text");
    const ocrFromDesc =
      dcDescription != null &&
      dcDescription.toLowerCase().includes("mode texte");
    const ocrAvailable = ocrFromMode || ocrFromDesc;

    // Page count: try `<nbPages>` if present, fall back to parsing the
    // "Nombre total de vues : N" string in <dc:format>. Final fallback: null.
    const nbPages = parseIntOrNull(r.nbPages ?? r.pageNumber);
    const pageCount = nbPages ?? extractPageCountFromFormat(dc["dc:format"]);

    const slug = arkToSlug(canonicalArk);
    const iiifManifestUrl = `${GALLICA}/iiif/ark:/12148/${slug}/manifest.json`;

    return {
      ark: canonicalArk,
      title,
      creator,
      date,
      docType,
      ocrAvailable,
      pageCount,
      iiifManifestUrl,
      // Carry the parsed envelope so downstream consumers can pull rare fields
      // (e.g. raw language) without re-fetching.
      raw: {
        ...(dc as Record<string, unknown>),
        language: lang,
        mode_indexation: modeIndexation,
        nqamoyen: textOf(r.nqamoyen),
        pageNumber: pageCount,
        typedoc: textOf(r.typedoc),
      },
    };
  }

  /**
   * Fallback metadata path for ARKs with no usable OAIRecord. Fetches the IIIF
   * manifest and derives a BnfDocInfo from `manifest.metadata[]`. Forces the
   * image (Holo) pipeline: `ocrAvailable: false` and an image `docType`, since
   * these are iconographic documents that carry no machine OCR.
   *
   * If the manifest itself is permanently unavailable, the document genuinely
   * does not exist for us — we rethrow the *original* OAIRecord error so the
   * skip reason reflects the primary cause.
   */
  private async getDocumentInfoFromManifest(
    canonicalArk: string,
    oaiError: PermanentBnfError,
  ): Promise<BnfDocInfo> {
    let manifest: Manifest;
    try {
      manifest = await this.getManifest(canonicalArk);
    } catch (e) {
      if (e instanceof PermanentBnfError) throw oaiError;
      throw e; // transient: let pg-boss retry the whole doc-job
    }

    // Prefer the `Title` metadata pair over the manifest's top-level label:
    // for BnF the label is often the shelfmark ("BnF, département Cartes et
    // plans, GE D-8246") while the metadata Title carries the real title
    // ("Plan de Paris"). Fall back to the label when no Title pair exists.
    const title =
      metadataValue(manifest.metadata, ["title", "titre"]) ?? manifest.title;
    const creator = metadataValue(manifest.metadata, [
      "creator",
      "auteur",
      "author",
      "créateur",
      "createur",
    ]);
    const date = metadataValue(manifest.metadata, [
      "date",
      "date d'édition",
      "date d'edition",
      "publication date",
    ]);
    // The manifest's declared type is kept for metadata richness, but docType
    // is forced to an image type so the doc routes through the Holo path.
    const declaredType = metadataValue(manifest.metadata, ["type", "nature"]);

    const slug = arkToSlug(canonicalArk);
    const iiifManifestUrl = `${GALLICA}/iiif/ark:/12148/${slug}/manifest.json`;

    return {
      ark: canonicalArk,
      title,
      creator,
      date,
      docType: "image",
      ocrAvailable: false,
      pageCount: manifest.totalPages || null,
      iiifManifestUrl,
      raw: {
        source: "iiif_manifest_fallback",
        oaiRecordError: oaiError.cause,
        manifestType: declaredType,
        metadata: manifest.metadata,
      },
    };
  }

  // ---------------- getDocumentText ----------------

  /**
   * Primary OCR source: the Gallica viewer AJAX endpoint (not under the 5/min
   * ALTO quota). Falls back to the per-page ALTO crawl only if the viewer
   * endpoint errors or changes shape. See `viewer-ocr.ts` for why.
   */
  async getDocumentText(
    ark: string,
    opts: { maxPages?: number; startPage?: number } = {},
  ): Promise<RawDocText> {
    const canonicalArk = ensureCanonicalArk(ark);
    try {
      const viaViewer = await this.getDocumentTextViaViewer(canonicalArk, opts);
      // A successful harvest (even of a partially-restricted doc) is the
      // authoritative result — restricted text exists nowhere else. Only an
      // empty harvest falls through to ALTO, in case the doc has OCR the
      // viewer didn't expose.
      if (viaViewer.pages.length > 0) return viaViewer;
      console.warn(
        `[bnf-api] viewer OCR returned 0 text pages for ${canonicalArk}; trying ALTO`,
      );
    } catch (err) {
      console.warn(
        `[bnf-api] viewer OCR failed for ${canonicalArk} (${
          err instanceof Error ? err.message : String(err)
        }); falling back to ALTO`,
      );
    }
    return this.getDocumentTextViaAlto(canonicalArk, opts);
  }

  /** Viewer-OCR harvest adapted to the RawDocText contract. */
  private async getDocumentTextViaViewer(
    canonicalArk: string,
    opts: { maxPages?: number; startPage?: number },
  ): Promise<RawDocText> {
    // ARK body without the "ark:/12148/" prefix, as the viewer URL expects.
    const arkId = arkToSlug(canonicalArk);
    const result = await fetchViewerOcr(arkId, { maxViews: opts.maxPages });
    const pages = result.pages
      .filter((p) => p.ocrText && p.ocrText.trim().length > 0)
      .map((p) => ({ ordre: p.view, text: p.ocrText as string }));
    return { pages, page_count: result.totalViews };
  }

  private async getDocumentTextViaAlto(
    ark: string,
    opts: { maxPages?: number; startPage?: number } = {},
  ): Promise<RawDocText> {
    const canonicalArk = ensureCanonicalArk(ark);
    const maxPages = opts.maxPages ?? 200;
    const startPage = Math.max(1, opts.startPage ?? 1);

    // Step 1: page list.
    const paginationUrl = `${GALLICA}/services/Pagination?ark=${encodeURIComponent(canonicalArk)}`;
    const paginationXml = await withBnfRetry(
      async () => {
        const { status, body } = await fetchText(paginationUrl);
        const err = classifyStatus(status, body, paginationUrl);
        if (err) throw err;
        return body;
      },
      { label: "Pagination" },
    );

    let pagination: unknown;
    try {
      pagination = paginationParser.parse(paginationXml);
    } catch (e) {
      throw new TransientBnfError("xml_parse_failed", {
        hint: `Pagination: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const ordres = extractPageOrdres(pagination);
    if (ordres.length === 0) {
      // No pages discovered — treat as a permanent oddity (book without pages
      // doesn't get retried; the prepare layer will surface this as
      // `ocr_fetch_failed` because zero pages have text).
      return { pages: [], page_count: 0 };
    }

    const slice = ordres.slice(startPage - 1, startPage - 1 + maxPages);

    // Step 2: per-page ALTO with bounded concurrency. A single page failing
    // does NOT fail the whole call — empty text just means "no OCR here".
    //
    // Concurrency note: Gallica's RequestDigitalElement endpoint is sharply
    // rate-limited (429 storms even at 4 parallel). Serializing per-doc is
    // the only stable knob — books with many pages are slower but complete.
    const concurrency = 1;
    const results: Array<{ ordre: number; text: string }> = new Array(slice.length);

    // Per-doc page-failure ceiling: if too many pages within this single
    // getDocumentText call hit their full retry budget, we conclude that
    // Gallica is rate-limiting THIS document and bail with a transient
    // error so the whole doc-job retries cleanly later — rather than
    // committing a half-empty corpus row.
    //
    // Threshold rationale: Gallica routinely 404s individual folios that
    // genuinely lack OCR (blank pages, plates). Those are NOT counted as
    // failures — only ALTO calls that exhausted retries via
    // withBnfRetry are. Below the 4-page floor the ratio is too noisy to
    // be meaningful (1 failure of 3 = 33%), so we skip the check entirely.
    const failRatio = readPageFailRatio();
    let pageFailures = 0;
    let pagesAttempted = 0;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= slice.length) return;
        const ordre = slice[i]!;
        pagesAttempted++;
        const outcome = await fetchAltoPage(canonicalArk, ordre);
        if (outcome.exhausted) pageFailures++;
        results[i] = { ordre, text: outcome.text };

        if (
          pagesAttempted > 4 &&
          pageFailures / pagesAttempted > failRatio
        ) {
          throw new TransientBnfError("rate_limited_doc", {
            hint: `${canonicalArk}: ${pageFailures}/${pagesAttempted} ALTO pages exhausted retries (>${(failRatio * 100).toFixed(0)}%)`,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()),
    );

    const pages = results.filter((p) => p.text.trim().length > 0);

    return { pages, page_count: ordres.length };
  }

  // ---------------- getManifest ----------------

  async getManifest(
    ark: string,
    opts: { maxCanvases?: number } = {},
  ): Promise<Manifest> {
    const canonicalArk = ensureCanonicalArk(ark);
    const maxCanvases = opts.maxCanvases ?? 200;
    const slug = arkToSlug(canonicalArk);
    const url = `${GALLICA}/iiif/ark:/12148/${slug}/manifest.json`;

    const json = await withBnfRetry(
      async () => {
        const { status, body } = await fetchText(url, {
          accept: "application/json, application/ld+json",
        });
        const err = classifyStatus(status, body, url);
        if (err) throw err;
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch (e) {
          throw new TransientBnfError("json_parse_failed", {
            hint: `manifest: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      },
      { label: "manifest" },
    );

    const title =
      typeof json.label === "string"
        ? json.label
        : Array.isArray(json.label) && json.label.length > 0 && typeof json.label[0] === "string"
          ? (json.label[0] as string)
          : null;

    const allCanvases: ManifestCanvas[] = [];
    const sequences = Array.isArray(json.sequences) ? json.sequences : [];
    for (const seq of sequences) {
      if (!seq || typeof seq !== "object") continue;
      const canvases = Array.isArray((seq as Record<string, unknown>).canvases)
        ? ((seq as Record<string, unknown>).canvases as unknown[])
        : [];
      for (let i = 0; i < canvases.length; i++) {
        const c = canvases[i];
        if (!c || typeof c !== "object") continue;
        const obj = c as Record<string, unknown>;
        const id = typeof obj["@id"] === "string" ? (obj["@id"] as string) : null;
        // Derive ordre from "/f<N>" in the canvas id when possible; otherwise
        // fall back to 1-based position.
        const m = id ? /\/f(\d+)(?:\/|$)/.exec(id) : null;
        const ordre = m ? parseInt(m[1]!, 10) : i + 1;

        const label = typeof obj.label === "string" ? (obj.label as string) : null;
        const width = typeof obj.width === "number" ? (obj.width as number) : null;
        const height = typeof obj.height === "number" ? (obj.height as number) : null;

        let imageServiceUrl: string | null = null;
        const images = Array.isArray(obj.images) ? (obj.images as unknown[]) : [];
        const firstImg = images[0];
        if (firstImg && typeof firstImg === "object") {
          const resource = (firstImg as Record<string, unknown>).resource;
          if (resource && typeof resource === "object") {
            const service = (resource as Record<string, unknown>).service;
            if (service && typeof service === "object") {
              const sid = (service as Record<string, unknown>)["@id"];
              if (typeof sid === "string") imageServiceUrl = sid;
            }
          }
        }

        allCanvases.push({ ordre, label, width, height, imageServiceUrl });
      }
    }

    return {
      title,
      metadata: parseManifestMetadata(json.metadata),
      totalPages: allCanvases.length,
      canvases: allCanvases.slice(0, maxCanvases),
    };
  }

  // ---------------- getImageUrl ----------------

  async getImageUrl(
    ark: string,
    opts: { ordre?: number; size?: string } = {},
  ): Promise<string> {
    const canonicalArk = ensureCanonicalArk(ark);
    const slug = arkToSlug(canonicalArk);
    const ordre = opts.ordre ?? 1;
    const size = opts.size ?? "!1280,1280";
    return `${GALLICA}/iiif/ark:/12148/${slug}/f${ordre}/full/${size}/0/native.jpg`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureCanonicalArk(ark: string): string {
  const trimmed = ark.trim();
  if (!trimmed.startsWith("ark:/12148/")) {
    throw new PermanentBnfError("bad_ark", {
      hint: `expected "ark:/12148/<id>", got: ${ark}`,
    });
  }
  return trimmed;
}

/**
 * True for BnF catalogue-notice ARKs (`ark:/12148/cb…`) — bibliographic or
 * authority records, not digitized documents. They have no IIIF surface and no
 * pages, so any attempt to fetch text resets the connection. Mirrors the app's
 * `sourceFromArk` "catalogue" mapping (lib/mcp/vocab.ts) — keep the two in sync.
 */
function isCatalogueNotice(canonicalArk: string): boolean {
  return /^ark:\/12148\/cb/.test(canonicalArk);
}

/**
 * Flatten an IIIF Presentation v2 `metadata[]` array to `{label, value}` pairs.
 * Each label/value may be a bare string, a `{"@value","@language"}` object, or
 * an array of those (one per language). We keep the French value when present.
 */
function parseManifestMetadata(
  raw: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = iiifValueToString(e.label);
    const value = iiifValueToString(e.value);
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Coerce an IIIF v2 language-mapped value to a single string (French preferred). */
function iiifValueToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    const fr = v.find(
      (x) =>
        x &&
        typeof x === "object" &&
        /^fr/i.test(String((x as Record<string, unknown>)["@language"] ?? "")),
    );
    return iiifValueToString(fr ?? v[0]);
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["@value"] === "string") return (o["@value"] as string).trim();
  }
  return "";
}

/** First metadata value whose (case-insensitive) label matches any candidate. */
function metadataValue(
  metadata: Array<{ label: string; value: string }>,
  labels: string[],
): string | null {
  const wanted = new Set(labels.map((l) => l.toLowerCase().trim()));
  for (const { label, value } of metadata) {
    if (wanted.has(label.toLowerCase().trim())) {
      return value.trim() || null;
    }
  }
  return null;
}

function extractPageOrdres(pagination: unknown): number[] {
  if (!pagination || typeof pagination !== "object") return [];
  const root = (pagination as Record<string, unknown>).livre as
    | Record<string, unknown>
    | undefined;
  if (!root || typeof root !== "object") {
    // Some shapes wrap pages directly under <pages>.
    return extractPagesFromContainer(pagination);
  }
  const pages = (root as Record<string, unknown>).pages as
    | Record<string, unknown>
    | undefined;
  if (!pages || typeof pages !== "object") {
    return extractPagesFromContainer(root);
  }
  return extractPagesFromContainer(pages);
}

function extractPagesFromContainer(container: unknown): number[] {
  if (!container || typeof container !== "object") return [];
  const obj = container as Record<string, unknown>;
  const list = obj.page;
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const ordre = parseIntOrNull((p as Record<string, unknown>).ordre);
    if (ordre != null) out.push(ordre);
  }
  return out;
}

/**
 * Outcome of a single ALTO fetch.
 *
 *   - `text`: the OCR text (possibly "" for legitimately empty / 404 folios).
 *   - `exhausted`: true iff the call burned through every retry and still
 *     failed. Distinct from "page has no OCR" — only `exhausted=true` should
 *     count toward the per-doc rate-limit ceiling in getDocumentText.
 */
interface AltoOutcome {
  text: string;
  exhausted: boolean;
}

/**
 * Fetch and parse a single ALTO page. 404 = no OCR for this folio → ("", false).
 * Network / 5xx / retry exhaustion → ("", true), which the caller may roll up
 * into a per-doc rate_limited_doc decision.
 */
async function fetchAltoPage(ark: string, ordre: number): Promise<AltoOutcome> {
  const url = `${GALLICA}/RequestDigitalElement?O=${encodeURIComponent(ark)}&E=ALTO&Deb=${ordre}`;
  try {
    const text = await withBnfRetry(
      async () => {
        const { status, body } = await fetchText(url, {
          timeoutMs: PAGE_TIMEOUT_MS,
          rateLimiter: altoRateLimit, // strict 5/min — ALTO only
        });
        // 404 on a single page = no OCR for this folio. Not an error.
        if (status === 404) return "";
        const err = classifyStatus(status, body, url);
        if (err) throw err;
        if (!body || body.trim().length === 0) return "";
        return parseAltoText(body);
      },
      { label: `ALTO[${ordre}]`, attempts: 3, baseMs: 400, totalBudgetMs: 30_000 },
    );
    return { text, exhausted: false };
  } catch (e) {
    // Per-page failure → empty page text but flagged as exhausted so the
    // doc-level ceiling can fire. Logged for visibility.
    console.warn(
      `[bnf-api] ALTO page ${ordre} of ${ark} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { text: "", exhausted: true };
  }
}

/**
 * Per-doc page-failure ratio (default 0.25). Configurable via
 * BNF_DOC_PAGE_FAIL_RATIO so we can dial it during incident response
 * without redeploying.
 */
function readPageFailRatio(): number {
  const raw = process.env.BNF_DOC_PAGE_FAIL_RATIO;
  if (raw == null || raw.trim() === "") return 0.25;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(
      `Invalid BNF_DOC_PAGE_FAIL_RATIO=${raw}: expected number in (0, 1).`,
    );
  }
  return n;
}

/**
 * Extract text from ALTO XML: concatenate <String CONTENT="..."> across
 * <TextLine> tags, joining words with spaces and lines with newlines.
 */
function parseAltoText(xml: string): string {
  let parsed: unknown;
  try {
    parsed = altoParser.parse(xml);
  } catch {
    return "";
  }
  const root = (parsed as Record<string, unknown>).alto as
    | Record<string, unknown>
    | undefined;
  if (!root) return "";
  const layout = root.Layout as Record<string, unknown> | undefined;
  if (!layout) return "";
  const pages = Array.isArray(layout.Page) ? (layout.Page as unknown[]) : [];

  const lines: string[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const printSpace = (page as Record<string, unknown>).PrintSpace as
      | Record<string, unknown>
      | undefined;
    if (!printSpace) continue;
    collectLines(printSpace, lines);
  }
  return lines.join("\n").trim();
}

/**
 * Walk an ALTO subtree collecting one string per TextLine. TextBlocks group
 * TextLines and TextLines group Strings; the spec also allows ComposedBlock
 * containers — we recurse defensively.
 */
function collectLines(node: Record<string, unknown>, out: string[]): void {
  const textBlocks = Array.isArray(node.TextBlock) ? (node.TextBlock as unknown[]) : [];
  for (const tb of textBlocks) {
    if (!tb || typeof tb !== "object") continue;
    const tbObj = tb as Record<string, unknown>;
    const textLines = Array.isArray(tbObj.TextLine) ? (tbObj.TextLine as unknown[]) : [];
    for (const tl of textLines) {
      if (!tl || typeof tl !== "object") continue;
      const strings = Array.isArray((tl as Record<string, unknown>).String)
        ? ((tl as Record<string, unknown>).String as unknown[])
        : [];
      const words: string[] = [];
      for (const s of strings) {
        if (!s || typeof s !== "object") continue;
        const content = (s as Record<string, unknown>)["@_CONTENT"];
        if (typeof content === "string" && content.length > 0) {
          words.push(content);
        }
      }
      if (words.length > 0) out.push(words.join(" "));
    }
    // ALTO can also nest ComposedBlock → TextBlock; recurse.
    if (Array.isArray(tbObj.ComposedBlock)) {
      for (const cb of tbObj.ComposedBlock as unknown[]) {
        if (cb && typeof cb === "object") {
          collectLines(cb as Record<string, unknown>, out);
        }
      }
    }
  }
  // PrintSpace might also host ComposedBlock at the top level.
  if (Array.isArray(node.ComposedBlock)) {
    for (const cb of node.ComposedBlock as unknown[]) {
      if (cb && typeof cb === "object") {
        collectLines(cb as Record<string, unknown>, out);
      }
    }
  }
}
