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
 *   - No metadata orchestration. Before the 2026-08-11 rate-collapse incident
 *     (ai-memories/tech/repos/bnf/ingest-hardening) this client owned
 *     getDocumentInfo(): try the manifest, fall back to OAI. That meant the
 *     metadata stage fetched a SECOND, ungated copy of the manifest that the
 *     manifest stage fetched again — the manifest budget (40/min, separate from
 *     the 1000/min global budget) collapsed under offered demand in the
 *     thousands/min. The orchestration now lives in MetadataStage, which shares
 *     ONE cached manifest + ONE rate gate with ManifestStage. This client only
 *     exposes the two primitives that orchestration composes: getManifest
 *     (rate-gated by the caller) and getDocumentInfoViaOai (the ungated
 *     fallback), plus docInfoFromManifest — a pure function, not a method, so
 *     any caller with a manifest (fetched or cache-hit) can derive the same
 *     BnfDocInfo without a second HTTP call.
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

// Per-request timeouts, split by which upstream host the call lands on:
//
//   - PAGE_TIMEOUT_MS (135s): every call that goes through the broker to the
//     token'd IIIF host (openapiproext.bnf.fr) — manifest AND folio (ALTO/image).
//     The broker's own upstream timeout (BNF_UPSTREAM_TIMEOUT_MS, 120s) is what
//     should fire first and classify cleanly (a 5xx/abort the client can retry
//     on); ours is set a touch HIGHER so the broker's clean timeout always wins
//     instead of the worker aborting the broker mid-flight and logging an opaque
//     "operation was aborted" (F4, ai-memories/tech/repos/bnf/ingest-hardening —
//     getManifest used to run on DEFAULT_TIMEOUT_MS, which is SHORTER than the
//     broker's own 120s upstream budget, so the worker's abort raced and usually
//     lost against a broker that was itself still legitimately waiting).
//   - DEFAULT_TIMEOUT_MS (45s): the OAI-PMH fallback ONLY. oai.bnf.fr is
//     ungated (no OAuth, no shared quota) and fast — a 45s budget is already
//     generous for it.
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

/**
 * Derive a full BnfDocInfo from an already-obtained IIIF v3 manifest — pure, no
 * I/O. `canonicalArk` must already be validated (ensureCanonicalArk) by the
 * caller; this function only shapes data, it never classifies an ARK.
 *
 * Exported (not a client method) so the ONE caller who actually fetches the
 * manifest — MetadataStage, behind its shared cache + rate gate — can derive
 * BnfDocInfo from either a freshly-fetched manifest OR one it found already
 * cached under keys.manifest(ark) (the SAME blob ManifestStage reads/writes),
 * without a second HTTP call either way. This split is the F1/F2 fix: metadata
 * resolution and manifest fan-out used to each fetch their own copy of the same
 * manifest; now there is exactly one fetch per ARK, gated once.
 *
 *   • title    — `Titre` metadata pair, else the manifest label (BnF's label is
 *                often the shelfmark; the Titre pair carries the real title).
 *   • ocr      — presence of the `Taux OCR` pair (absent on manuscripts/maps/
 *                scores/image-serials → image lane; present → text lane). The
 *                manifest-native equivalent of OAI's "Avec mode texte" flag.
 *   • docType  — `Type document` (Livre/Carte/Manuscrit/Musique notée…) joined
 *                with the generic `Type` ("publication en série imprimée" =
 *                press). Kept raw+lowercased: classifyLane substring-matches it.
 *   • pageCount— the canvas count (manifest.totalPages) — authoritative AND
 *                independent of maxCanvases (parseV3Manifest computes totalPages
 *                from the full canvas list, before slicing it to maxCanvases).
 *   • subtype  — null: the fine Gallica typedoc sub-category (fascicules/titres)
 *                lives only in OAI's setSpec, which the manifest does not carry.
 */
export function docInfoFromManifest(manifest: Manifest, canonicalArk: string): BnfDocInfo {
  const title = metadataValue(manifest.metadata, ["titre", "title"]) ?? manifest.title;
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
  const ocrAvailable = metadataValue(manifest.metadata, ["taux ocr", "taux d'ocr"]) !== null;
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

export class LiveBnfClient implements BnfClient {
  // ---------------- getDocumentInfoViaOai ----------------

  /**
   * Fallback metadata path: the ungated OAI-PMH endpoint (oai.bnf.fr) via the
   * broker. Called by MetadataStage ONLY when the IIIF manifest is permanently
   * unavailable (a rare, legacy/edge-ARK condition — every digitized doc has a
   * manifest); the manifest is the PRIMARY path (see docInfoFromManifest).
   * Dublin Core fields under <OAI-PMH><GetRecord><record><metadata><oai_dc:dc>.
   * OCR availability is the "Avec mode texte" <dc:description> flag (scanning
   * ALL descriptions); page count is the "Nombre total de vues" <dc:format>
   * note — collection-level and occasionally wildly wrong for periodical issues
   * (e.g. bpt6k268418n: 4 real folios, OAI claims 3197), which is exactly why
   * the manifest's canvas count is authoritative when it's available.
   */
  async getDocumentInfoViaOai(ark: string): Promise<BnfDocInfo> {
    const canonicalArk = ensureCanonicalArk(ark);
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

    // PAGE_TIMEOUT_MS, not DEFAULT_TIMEOUT_MS — this is a broker→openapiproext
    // call like ALTO/image, not the ungated OAI call. See the timeout-constants
    // header comment (F4: this used to run on the shorter budget, which raced
    // and usually lost against the broker's own legitimate 120s upstream wait).
    const { status, bytes, contentType } = await brokerFetch(
      url,
      "application/json, application/ld+json",
      PAGE_TIMEOUT_MS,
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
