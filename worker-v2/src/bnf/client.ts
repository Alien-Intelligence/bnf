/**
 * LiveBnfClient — the concrete BnfClient that talks to the real BnF, ported
 * from V1's worker/src/prepare/bnf-api.ts but reshaped to the V2 contract:
 *
 *   - Per-folio, not per-doc. V1's getDocumentText crawled every page behind a
 *     fan-out + per-doc fail-ratio ceiling. V2's fetch STAGE owns that loop, so
 *     this client only exposes single-folio fetches (fetchAltoFolio /
 *     fetchImageFolio).
 *   - Partner-mode ONLY. V1 kept the legacy gallica.bnf.fr direct/relay path for
 *     pre-broker dev; V2 is always behind the broker (the broker is live in
 *     prod), so every call goes through brokerGet. If the broker is unset the
 *     client throws Permanent("config") rather than silently degrading.
 *   - No withBnfRetry. Retry is the fetch stage's concern (pg-boss + RateGate);
 *     this client throws Transient/Permanent on the FIRST failure and lets the
 *     stage decide. Double-retrying would burn the shared 300/min budget.
 *
 * Status classification (classifyStatus) is byte-identical to V1: 403→forbidden
 * (permanent — it's an access decision, not throttling), 404→not_found, 400→
 * bad_ark, 429→transient(is429), 5xx→transient.
 */
import type { AltoFolio, BnfClient, BnfDocInfo, Manifest } from "./types.js";
import { PermanentBnfError, TransientBnfError } from "./errors.js";
import { brokerGet, brokerUrl } from "./broker-client.js";
import {
  arkToSlug,
  descriptionsHaveModeTexte,
  ensureCanonicalArk,
  extractPageCountFromFormat,
  firstOrNull,
  isCatalogueNotice,
  metadataValue,
  oaiParser,
  parseAltoText,
  parseV3Manifest,
  pickDcType,
  pickFirstLanguage,
  pickTypedocFromHeader,
  textOf,
  typedocSubtype,
} from "./parse.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 15_000;

// Partner-API endpoints (V2 is always partner mode — see file header):
//   - metadata:  ungated OAI-PMH (oai.bnf.fr) — no auth, no Cloudflare, no quota.
//   - IIIF v3:   openapiproext.bnf.fr via the broker (OAuth + shared rate caps).
// IIIF MUST go to openapiproext.bnf.fr (the token'd host), NOT openapi.bnf.fr —
// that public host serves IIIF from a no-token, anonymous-per-IP pool that does
// not count against our 300/min quota and throttles behind the shared egress IP.
const OAI_PMH = "http://oai.bnf.fr/oai2/OAIHandler";
const OPENAPI = (process.env.BNF_API_BASE_URL ?? "https://openapiproext.bnf.fr").replace(
  /\/$/,
  "",
);

interface FetchResult {
  status: number;
  bytes: Buffer;
  contentType: string;
}

/**
 * One broker fetch, normalizing transport failure into a TransientBnfError so
 * the stage retries it (a broker/network blip is never permanent). Returns the
 * raw bytes + status; charset decoding and status classification happen in the
 * callers (which know whether they want text or image bytes).
 */
async function brokerFetch(
  url: string,
  accept: string,
  timeoutMs: number,
): Promise<FetchResult> {
  if (!brokerUrl()) {
    // V2 has no legacy direct path. A missing broker is a deployment error, not
    // a per-doc condition — fail it permanently so it surfaces loudly rather
    // than retrying forever against a chokepoint that isn't there.
    throw new PermanentBnfError("config", {
      hint: "BNF_BROKER_URL is not set; the V2 client requires the broker",
    });
  }
  try {
    const { status, bytes, contentType } = await brokerGet(url, accept, timeoutMs);
    return { status, bytes, contentType };
  } catch (err) {
    throw new TransientBnfError("network", {
      hint: `${url}: broker ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Decode BnF response bytes using the DECLARED charset, not a blind UTF-8.
 *
 * BnF's XML (ALTO OCR, OAIRecord) is served as `encoding="iso-8859-1"` —
 * decoding those bytes as UTF-8 turns every accented French character into
 * U+FFFD (`THÉÂTRE` → corrupted), silently poisoning the OCR text that becomes
 * chunks and folio citations. Resolve the charset in priority order: HTTP
 * `Content-Type; charset=`, then the XML prolog `encoding="…"`, else UTF-8 (so
 * JSON manifests — no prolog, UTF-8 by spec — stay correct).
 */
function decodeBnfBytes(bytes: Buffer, contentType?: string): string {
  let charset: string | undefined;
  const ctMatch = contentType?.match(/charset=([^;]+)/i);
  if (ctMatch) charset = ctMatch[1]!.trim().toLowerCase();
  if (!charset) {
    // Sniff the XML prolog from the ASCII-safe head (the declaration is itself
    // ASCII regardless of the document body's encoding).
    const head = bytes.subarray(0, 256).toString("latin1");
    const m = head.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i);
    if (m) charset = m[1]!.trim().toLowerCase();
  }
  if (!charset || charset === "utf-8" || charset === "utf8") {
    return bytes.toString("utf8");
  }
  try {
    // TextDecoder handles iso-8859-1 / latin1 / windows-1252 and many others.
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // Unknown label — UTF-8 is the least-surprising fallback.
    return bytes.toString("utf8");
  }
}

/**
 * Classify HTTP non-2xx responses into Transient vs Permanent errors.
 * 200/2xx return null (caller handles parsing). Verbatim from V1.
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
  if (status === 403) {
    // BnF returns 403 {"reason":"Forbidden"} for access-restricted documents
    // (rights-restricted, on-site-only, embargoed). This is a PERMANENT
    // per-document decision: no retry changes it. It is NOT rate limiting (429)
    // and NOT an expired token (the broker re-mints OAuth before we see this).
    return new PermanentBnfError("forbidden", {
      status,
      hint: `${url}: ${body.slice(0, 200)}`,
    });
  }
  if (status === 429) {
    return new TransientBnfError("rate_limited", { status, is429: true, hint: url });
  }
  if (status >= 500) {
    return new TransientBnfError("server_error", { status, hint: url });
  }
  // Everything else (other 4xx) — Gallica's behavior here is inconsistent;
  // treat as transient so the stage's retry policy can sort it out.
  return new TransientBnfError(`http_${status}`, {
    status,
    hint: `${url}: ${body.slice(0, 200)}`,
  });
}

export class LiveBnfClient implements BnfClient {
  // ---------------- getDocumentInfo ----------------

  async getDocumentInfo(ark: string): Promise<BnfDocInfo> {
    const canonicalArk = ensureCanonicalArk(ark);
    // Fail fast on catalogue notices. `cb*` ARKs are bibliographic/authority
    // records, not digitized documents — they have no pages, so every fetch
    // ECONNRESETs. The prefix is deterministic → a permanent classification
    // (NOT a generic "network error → permanent" rule; real throttling on a
    // digitized ARK must still retry).
    if (isCatalogueNotice(canonicalArk)) {
      throw new PermanentBnfError("not_digitized", {
        hint: `${canonicalArk}: catalogue notice (cb*), not a digitized document`,
      });
    }
    try {
      return await this.getDocumentInfoViaOaiPmh(canonicalArk);
    } catch (e) {
      // OAI is incomplete: many ARKs that are perfectly viewable on Gallica IIIF
      // (Cartes & Plans, Estampes, specialist series) return an error / empty
      // envelope from OAI. The IIIF manifest is the universal metadata fallback
      // — derive title/creator/date from manifest.metadata[] and route through
      // the image lane. Only a *permanent* OAI failure triggers it; transient
      // errors propagate so the stage retries the metadata fetch.
      if (e instanceof PermanentBnfError) {
        return await this.getDocumentInfoFromManifest(canonicalArk, e);
      }
      throw e;
    }
  }

  /**
   * Partner-API metadata path: the ungated OAI-PMH endpoint (oai.bnf.fr) via the
   * broker. Dublin Core fields under <OAI-PMH><GetRecord><record><metadata>
   * <oai_dc:dc>. OCR availability is the "Avec mode texte" <dc:description> flag
   * (scanning ALL descriptions); page count is the "Nombre total de vues"
   * <dc:format> note.
   */
  private async getDocumentInfoViaOaiPmh(canonicalArk: string): Promise<BnfDocInfo> {
    const identifier = `oai:bnf.fr:gallica/${canonicalArk}`;
    const url = `${OAI_PMH}?verb=GetRecord&metadataPrefix=oai_dc&identifier=${encodeURIComponent(identifier)}`;

    const { status, bytes, contentType } = await brokerFetch(
      url,
      "application/xml, text/xml, */*",
      DEFAULT_TIMEOUT_MS,
    );
    const body = decodeBnfBytes(bytes, contentType);
    const err = classifyStatus(status, body, url);
    if (err) throw err;

    let parsed: unknown;
    try {
      parsed = oaiParser.parse(body);
    } catch (e) {
      throw new TransientBnfError("xml_parse_failed", {
        hint: `OAI: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const pmh = (parsed as Record<string, unknown>)["OAI-PMH"] as
      | Record<string, unknown>
      | undefined;
    if (!pmh || typeof pmh !== "object") {
      throw new PermanentBnfError("not_found", {
        hint: `OAI returned no <OAI-PMH> for ${canonicalArk}`,
      });
    }
    // <error code="idDoesNotExist"|...> → the ARK is unknown / not on Gallica.
    if (pmh.error != null) {
      throw new PermanentBnfError("not_found", {
        hint: `OAI error for ${canonicalArk}: ${textOf(pmh.error) ?? "error"}`,
      });
    }
    const getRecord = pmh.GetRecord as Record<string, unknown> | undefined;
    const record = getRecord?.record as Record<string, unknown> | undefined;
    const metadata = record?.metadata as Record<string, unknown> | undefined;
    const dc =
      (metadata?.["oai_dc:dc"] as Record<string, unknown> | undefined) ?? undefined;
    if (!dc || typeof dc !== "object") {
      throw new PermanentBnfError("not_found", {
        hint: `OAI dc envelope missing for ${canonicalArk}`,
      });
    }

    const title = textOf(firstOrNull(dc["dc:title"]));
    if (!title) {
      throw new PermanentBnfError("not_found", {
        hint: `OAI record has no title for ${canonicalArk}`,
      });
    }
    const creator = textOf(firstOrNull(dc["dc:creator"]));
    const date = textOf(dc["dc:date"]);
    // docType stays the RAW Gallica dc:type — the classify stage substring-matches
    // it to route the image lane. The typedoc gives the finer `subtype` facet.
    const docType = pickDcType(dc["dc:type"]);
    const typedoc = pickTypedocFromHeader(record?.header);
    const subtype = typedocSubtype(typedoc);
    const lang = pickFirstLanguage(dc["dc:language"]);
    const ocrAvailable = descriptionsHaveModeTexte(dc["dc:description"]);
    const pageCount = extractPageCountFromFormat(dc["dc:format"]);

    const slug = arkToSlug(canonicalArk);
    const iiifManifestUrl = `${OPENAPI}/iiif/presentation/v3/ark:/12148/${slug}/manifest.json`;

    return {
      ark: canonicalArk,
      title,
      creator,
      date,
      docType,
      subtype,
      ocrAvailable,
      pageCount,
      iiifManifestUrl,
      lang,
      raw: {
        ...(dc as Record<string, unknown>),
        language: lang,
        source: "oai_pmh",
        gallica_typedoc: typedoc,
        pageNumber: pageCount,
      },
    };
  }

  /**
   * Fallback metadata path for ARKs with no usable OAI record. Fetches the IIIF
   * manifest and derives a BnfDocInfo from `manifest.metadata[]`. Forces the
   * image lane: `ocrAvailable: false` and `docType: "image"`, since these are
   * iconographic documents that carry no machine OCR.
   *
   * If the manifest itself is permanently unavailable, the document genuinely
   * does not exist for us — rethrow the *original* OAI error so the skip reason
   * reflects the primary cause.
   */
  private async getDocumentInfoFromManifest(
    canonicalArk: string,
    oaiError: PermanentBnfError,
  ): Promise<BnfDocInfo> {
    let manifest: Manifest;
    try {
      manifest = await this.getManifest(canonicalArk, 200);
    } catch (e) {
      if (e instanceof PermanentBnfError) throw oaiError;
      throw e; // transient: let the stage retry the metadata fetch
    }

    // Prefer the `Title` metadata pair over the manifest's top-level label: for
    // BnF the label is often the shelfmark while the metadata Title carries the
    // real title. Fall back to the label when no Title pair exists.
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
    // Kept for richness, but docType is forced to "image" so the doc routes
    // through the image lane.
    const declaredType = metadataValue(manifest.metadata, ["type", "nature"]);
    const lang = metadataValue(manifest.metadata, ["language", "langue"]);

    const slug = arkToSlug(canonicalArk);
    const iiifManifestUrl = `${OPENAPI}/iiif/presentation/v3/ark:/12148/${slug}/manifest.json`;

    return {
      ark: canonicalArk,
      title,
      creator,
      date,
      docType: "image",
      subtype: null,
      ocrAvailable: false,
      pageCount: manifest.totalPages || null,
      iiifManifestUrl,
      lang,
      raw: {
        source: "iiif_manifest_fallback",
        oaiRecordError: oaiError.cause,
        manifestType: declaredType,
        metadata: manifest.metadata,
      },
    };
  }

  // ---------------- getManifest ----------------

  async getManifest(ark: string, maxCanvases: number): Promise<Manifest> {
    const canonicalArk = ensureCanonicalArk(ark);
    const slug = arkToSlug(canonicalArk);
    const url = `${OPENAPI}/iiif/presentation/v3/ark:/12148/${slug}/manifest.json`;

    const { status, bytes, contentType } = await brokerFetch(
      url,
      "application/json, application/ld+json",
      DEFAULT_TIMEOUT_MS,
    );
    const body = decodeBnfBytes(bytes, contentType);
    const err = classifyStatus(status, body, url);
    if (err) throw err;

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch (e) {
      throw new TransientBnfError("json_parse_failed", {
        hint: `manifest: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    return parseV3Manifest(json, maxCanvases);
  }

  // ---------------- fetchAltoFolio ----------------

  /**
   * Fetch + parse ONE folio's ALTO text. A 404 means this folio genuinely has
   * no OCR (blank page, plate) — that is NOT an error: return {text:"",
   * empty:true}. Any other non-2xx is classified and thrown for the stage.
   */
  async fetchAltoFolio(ark: string, ordre: number): Promise<AltoFolio> {
    const canonicalArk = ensureCanonicalArk(ark);
    const slug = arkToSlug(canonicalArk);
    const url = `${OPENAPI}/iiif/presentation/v3/ark:/12148/${slug}/f${ordre}/alto.xml`;

    const { status, bytes, contentType } = await brokerFetch(
      url,
      "application/xml, text/xml, */*",
      PAGE_TIMEOUT_MS,
    );
    if (status === 404) return { text: "", empty: true };
    const body = decodeBnfBytes(bytes, contentType);
    const err = classifyStatus(status, body, url);
    if (err) throw err;
    if (!body || body.trim().length === 0) return { text: "", empty: true };

    const text = parseAltoText(body);
    return { text, empty: text.trim() === "" };
  }

  // ---------------- fetchImageFolio ----------------

  /**
   * Fetch ONE folio's IIIF v3 image bytes (JPEG). Default size "max" (v3's
   * native-size token). Returns the raw Buffer; non-2xx is classified+thrown.
   */
  async fetchImageFolio(ark: string, ordre: number, size = "max"): Promise<Buffer> {
    const canonicalArk = ensureCanonicalArk(ark);
    const slug = arkToSlug(canonicalArk);
    const url = `${OPENAPI}/iiif/image/v3/ark:/12148/${slug}/f${ordre}/full/${size}/0/default.jpg`;

    const { status, bytes, contentType } = await brokerFetch(
      url,
      "image/jpeg",
      PAGE_TIMEOUT_MS,
    );
    if (status < 200 || status >= 300) {
      // Decode the (small) error body for classification context only.
      const body = decodeBnfBytes(bytes, contentType);
      const err = classifyStatus(status, body, url);
      if (err) throw err;
    }
    return bytes;
  }
}
