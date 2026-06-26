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

// Per-request timeouts. The BnF-facing budget is owned by the BROKER
// (BNF_UPSTREAM_TIMEOUT_MS, 120s) — under load BnF can take a long time to serve a
// folio image. The worker's broker-call timeout is set a touch HIGHER (135s) so the
// broker's own clean upstream-timeout (a 5xx/abort it can classify) wins, instead of
// the worker aborting the broker mid-flight and logging an opaque "operation was
// aborted". Page fetches (ALTO/image) were 15s — far too tight for a saturated BnF,
// which produced the bulk of the transient fetch aborts. Metadata (OAI) is fast, so
// it keeps a shorter budget.
const DEFAULT_TIMEOUT_MS = optionalIntEnv("BNF_META_TIMEOUT_MS", 45_000);
const PAGE_TIMEOUT_MS = optionalIntEnv("BNF_PAGE_TIMEOUT_MS", 135_000);

/** Read a positive-int env var, or fall back. Throws on a present-but-junk value. */
function optionalIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  return Math.floor(n);
}

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
    // PRIMARY: the IIIF v3 manifest (openapiproext.bnf.fr — the partner gateway,
    // on the broker's authenticated quota). It carries everything OAI did and
    // more: title/creator/date/lang, the `Taux OCR` text-layer signal, the doc
    // type (`Type document` + the "publication en série" press marker), and the
    // AUTHORITATIVE page count — the canvas count, which matches the real
    // fetchable folios (f1..fN). OAI's "Nombre total de vues" is collection-level
    // and wildly wrong for periodical issues (e.g. bpt6k268418n: 4 real folios,
    // OAI claims 3197), which the old OAI text lane over-fetched. See
    // ai-memories bnf-metadata-via-manifest.
    try {
      return await this.getDocumentInfoViaManifest(canonicalArk);
    } catch (e) {
      // FALLBACK: a permanently-unavailable manifest is rare (every digitized doc
      // has one) but possible for a few legacy/edge ARKs. Fall back to the OAI-PMH
      // record (ungated oai.bnf.fr via the broker) so those still resolve rather
      // than being dropped. Transient errors propagate so the stage retries.
      if (e instanceof PermanentBnfError) {
        return await this.getDocumentInfoViaOaiPmh(canonicalArk);
      }
      throw e;
    }
  }

  /**
   * PRIMARY metadata path — derive a full BnfDocInfo from the IIIF v3 manifest.
   *
   *   • title    — `Titre` metadata pair, else the manifest label (BnF's label is
   *                often the shelfmark; the Titre pair carries the real title).
   *   • ocr      — presence of the `Taux OCR` pair (absent on manuscripts/maps/
   *                scores/image-serials → image lane; present → text lane). The
   *                manifest-native equivalent of OAI's "Avec mode texte" flag.
   *   • docType  — `Type document` (Livre/Carte/Manuscrit/Musique notée…) joined
   *                with the generic `Type` ("publication en série imprimée" =
   *                press). Kept raw+lowercased: classifyLane substring-matches it.
   *   • pageCount— the canvas count (manifest.totalPages), authoritative.
   *   • subtype  — null: the fine Gallica typedoc sub-category (fascicules/titres)
   *                lives only in OAI's setSpec, which the manifest does not carry.
   */
  private async getDocumentInfoViaManifest(canonicalArk: string): Promise<BnfDocInfo> {
    // maxCanvases=1: we need only totalPages here (the true canvas count, computed
    // before the slice), not the canvas list — the fetch stage re-fetches it.
    const manifest = await this.getManifest(canonicalArk, 1);

    const title =
      metadataValue(manifest.metadata, ["titre", "title"]) ?? manifest.title;
    if (!title) {
      throw new PermanentBnfError("not_found", {
        hint: `manifest has no title for ${canonicalArk}`,
      });
    }
    const creator = metadataValue(manifest.metadata, [
      "créateur",
      "createur",
      "creator",
      "auteur",
      "author",
      "contributeur",
    ]);
    const date = metadataValue(manifest.metadata, [
      "date",
      "date d'édition",
      "date d'edition",
      "publication date",
    ]);
    const lang = metadataValue(manifest.metadata, ["langue", "language"]);
    const typeDocument = metadataValue(manifest.metadata, ["type document"]);
    const typeGeneric = metadataValue(manifest.metadata, ["type", "nature"]);
    const docType =
      [typeDocument, typeGeneric].filter(Boolean).join(" | ").toLowerCase() || null;
    const ocrAvailable =
      metadataValue(manifest.metadata, ["taux ocr", "taux d'ocr"]) !== null;
    const pageCount = manifest.totalPages || null;

    const slug = arkToSlug(canonicalArk);
    const iiifManifestUrl = `${OPENAPI}/iiif/presentation/v3/ark:/12148/${slug}/manifest.json`;

    return {
      ark: canonicalArk,
      title,
      creator,
      date,
      docType,
      subtype: null,
      ocrAvailable,
      pageCount,
      iiifManifestUrl,
      lang,
      raw: {
        source: "iiif_manifest",
        type_document: typeDocument,
        type: typeGeneric,
        language: lang,
        pageNumber: pageCount,
        metadata: manifest.metadata,
      },
    };
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
