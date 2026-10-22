// lib/bnf/direct.ts
// Direct HTTP client for BnF metadata resolution — bypasses the BnF MCP.
//
// WHY DIRECT (not the MCP): the MCP resolves Gallica documents through the
// platform External-API Gateway → Gallica connector. When that connector is
// down it returns "Connection failed" for every Gallica ARK, which stalled
// corpus metadata resolution. gallica.bnf.fr is reachable directly — but it
// sits behind Cloudflare, which 403s clients with no/!browser User-Agent and
// (here) rejects the IPv6 TLS handshake. So this client pins IPv4 and sends a
// browser UA. catalogue.bnf.fr is not Cloudflare-gated.
//
// When Cloudflare bot-fight-mode also rejects our TLS/HTTP2 fingerprint (a
// browser UA is not enough; the cf_clearance cookie is IP-bound so a captured
// cookie does NOT pass from the server), setting GALLICA_RELAY_URL routes the
// gallica.bnf.fr calls through the same curl_cffi sidecar the ingest worker
// uses. See lib/bnf/gallica-relay.ts. Only gallica.bnf.fr is relayed.
//
// Endpoints (confirmed by reading MCPs/mcp-bnf and curling the live APIs):
//   Gallica:   GET http://oai.bnf.fr/oai2/OAIHandler?verb=GetRecord
//                  &metadataPrefix=oai_dc&identifier=oai:bnf.fr:gallica/<ark>
//              → Dublin Core (oai_dc), parsed by lib/bnf/oai-record.ts. UNGATED
//                (no auth, no Cloudflare, no partner quota); through the broker
//                it spends the `external` bucket. It supplies title/creator/date/
//                language/publisher/subject, the typedoc (docType + subtype) and
//                the raw view count.
//   Manifest:  GET <BNF_IIIF_PRESENTATION_BASE_URL>/presentation/v3/<ark>/manifest.json
//              → IIIF v3 manifest on the BnF Presentation API (broker `manifest`
//                bucket, authenticated). Fetched ONLY by the hybrid rule below.
//   Catalogue: GET http://catalogue.bnf.fr/api/SRU ... bib.persistentId all "<ark>"
//              recordSchema=dublincore → Dublin Core.
//
// HYBRID GALLICA RESOLVER (SDS-945). OAI is always fetched first; the manifest is
// the exception, not the rule, because its bucket is the ingestion bottleneck:
//   1. OAI record fetched (external bucket).
//   2. OAI says "mode texte"            → ocr_available true,  no manifest call.
//      (100 % precise: 0 false positives over 276 sampled records.)
//   3. else the OAI docType is image-like → ocr_available false, no manifest call
//      (INGESTION_IMAGE_LIKE_TYPES: the flag is irrelevant to the image lanes).
//   4. else (a text-like document OAI is silent on: every press issue, ~4 % of
//      monographs, manuscripts, scores…) → fetch the manifest. OAI recall is not
//      good enough to decide "no text layer": a false verdict routes the document
//      to paid OCR. The manifest supplies ONLY the OCR flag, the authoritative
//      page count (canvas count) and the OCR rate; docType/subtype stay OAI's.
// Provenance is recorded on the returned record (`ocr_source`, `pages_source`).
// `mode: "staging"` (the research buffer) stops after step 2: buffer rows do not
// need the OCR flag before commit, and the commit-time resolve applies step 4.
//
// Returns BnfMcpResolveResult/Error (lib/bnf/types.ts) so the resolver and the
// normalize layer (lib/mcp/normalize.ts) are unchanged. Search stays on the MCP
// (in-band, agent-driven); only resolution lives here.
import "server-only"

import { Agent, fetch as undiciFetch } from "undici"

import {
  BNF_DIRECT_CONCURRENCY,
  BNF_HTTP_TIMEOUT_MS,
  BNF_MCP_RETRY_ATTEMPTS,
  BNF_MCP_RETRY_BASE_MS,
  BNF_MCP_RETRY_CAP_MS,
  BNF_USER_AGENT,
} from "@/lib/constants"
import {
  brokerGetText,
  brokerUrl,
  type ResponseHeaders,
} from "@/lib/bnf/broker-client"
import { presentationManifestUrl } from "@/lib/bnf/endpoints"
import { relayGetText, shouldRelay } from "@/lib/bnf/gallica-relay"
import { parseGallicaOaiRecord } from "@/lib/bnf/oai-record"
import {
  assertFullArk,
  bnfXmlParser,
  localArk,
  nodeText,
  XML_ATTR_PREFIX,
  type XmlNode,
} from "@/lib/bnf/wire"
import { env } from "@/lib/env"
import { withTimeout } from "@/lib/mcp/abort"
import {
  CANONICAL_OUTCOME_STATUS,
  OCR_SOURCE,
  PAGES_SOURCE,
  RESOLVE_MODE,
  type BnfMcpDocumentDetail,
  type BnfMcpResolveError,
  type BnfMcpResolveResult,
  type ResolveMode,
} from "@/lib/bnf/types"
import {
  BnfMcpAuthError,
  BnfMcpError,
  BnfMcpNotFoundError,
  BnfMcpRateLimitError,
} from "@/lib/mcp/errors"
import { normalizeDocument } from "@/lib/mcp/normalize"
import { type RetryOptions, type Settled, withConcurrency, withRetry } from "@/lib/mcp/retry"
import { GALLICA_DOC_TYPE, sourceFromArk } from "@/lib/mcp/vocab"
import { DOCUMENT_SOURCE, INGESTION_IMAGE_LIKE_TYPES } from "@/models/documents/schema"

export { RESOLVE_MODE, type ResolveMode }

/**
 * Outcome of classifying a catalogue (`cb…`) ARK against its digitized Gallica
 * reproduction. `upgraded` carries the digitized ARK to substitute; the other
 * two record why the notice stayed a notice (see Document.canonicalStatus).
 */
export type CanonicalizeOutcome =
  | { ark: string; status: typeof CANONICAL_OUTCOME_STATUS.UPGRADED; canonical: string }
  | { ark: string; status: typeof CANONICAL_OUTCOME_STATUS.NOT_DIGITIZED }
  | { ark: string; status: typeof CANONICAL_OUTCOME_STATUS.API_ERROR }

// Two transports per endpoint (dual-path):
//   • proext  — the authenticated partner gateway (openapiproext.bnf.fr). Used
//     whenever the broker is configured: the broker mints the OAuth bearer and
//     counts the call against the BnF API's own bucket and the global one (it
//     only tokenises the proext host and classifies by path — broker plan.ts).
//     The IIIF manifest (hybrid step 4) is on the Presentation API
//     (BNF_IIIF_PRESENTATION_BASE_URL); catalogue SRU and SPARQL are on
//     PROEXT_BASE below. This is the prod path.
//   • ungated — the legacy tokenless hosts (oai/catalogue/data.bnf.fr). The
//     no-broker dev fallback: proext needs creds the broker holds, so without a
//     broker we keep hitting the ungated hosts directly. The Presentation API is
//     unreachable there, so hybrid step 4 cannot run (see resolveGallica).
// OAI-PMH has no proext equivalent: Gallica metadata is read from the ungated
// oai.bnf.fr on BOTH paths. `egress.viaPartner` picks per call; it mirrors the
// broker check in the default egress so the URL and the transport always agree.
// All proext endpoints + their quirks were verified live through the broker on
// platform-prod (2026-06-26).
const PROEXT_BASE = env.BNF_API_BASE_URL.replace(/\/$/, "")

// data.bnf.fr SPARQL — a pure host swap on proext (same query, same params, same
// JSON result shape; verified: cb30055832f → bpt6k104247x identical both ways).
const DATABNF_SPARQL = {
  proext: `${PROEXT_BASE}/graphe/data/1.0.0/sparql`,
  ungated: "https://data.bnf.fr/sparql",
}
// Catalogue SRU. proext's `catalogueservice-cons` uses DIFFERENT recordSchema
// identifiers than legacy catalogue.bnf.fr — `DublinCore`/`UnimarcXML`, not
// `dublincore`/`unimarcxchange` (the legacy names return SRW diagnostic 1/66
// "unknown schema" on proext). The schema names travel with the endpoint, so
// they're bundled here. The parsed record shape is identical (removeNSPrefix
// flattens the `mxc:` UNIMARC prefix), so the callers' extraction is unchanged.
const CATALOGUE_SRU = {
  proext: {
    url: `${PROEXT_BASE}/catalogueservice-cons/1.0/SRU`,
    dc: "DublinCore",
    unimarc: "UnimarcXML",
  },
  ungated: {
    url: "http://catalogue.bnf.fr/api/SRU",
    dc: "dublincore",
    unimarc: "unimarcxchange",
  },
}
// Ungated OAI-PMH metadata endpoint (oai.bnf.fr) — NOT gallica.bnf.fr, which is
// Cloudflare-403'd from the server. No auth, no partner quota, no Cloudflare.
const GALLICA_OAI_PMH_URL = "http://oai.bnf.fr/oai2/OAIHandler"

// The RDA predicate data.bnf.fr puts on a manifestation node to link it to its
// digitized Gallica reproduction. The subject is the `#about` node of the
// catalogue ARK; the object is the full `https://gallica.bnf.fr/ark:/…` URL.
// Verified live 2026-06-22 (cb30055832f → bpt6k104247x). data.bnf.fr also
// carries the newer rdaregistry.info/Elements/m/#P30016 URI for the same link,
// but this older one is equally populated and matches the SPARQL guide.
const ELECTRONIC_REPRODUCTION =
  "http://rdvocab.info/RDARelationshipsWEMI/electronicReproduction"

// ARK families that denote a genuine digitized Gallica document (one with a
// IIIF manifest + consultable pages) — as opposed to a `cb…` notice echo or a
// `…/date` periodical-collection URL, which we must NOT treat as canonical.
const GALLICA_ARK_FAMILY = /^(bpt6k|btv1b|bd6t)/

// The manifest metadata labels carrying the text-layer rate ("Taux OCR": "78.21 %").
const TAUX_OCR_LABELS = ["taux ocr", "taux d'ocr"]

const SRU_VERSION = "1.2"
const SRU_OPERATION_SEARCH_RETRIEVE = "searchRetrieve"
const SRU_SINGLE_RECORD = "1"

/** SRU query for the one catalogue record whose persistent id is `ark`, in `recordSchema`. */
function catalogueSruParams(ark: string, recordSchema: string): Record<string, string> {
  return {
    version: SRU_VERSION,
    operation: SRU_OPERATION_SEARCH_RETRIEVE,
    query: `bib.persistentId all "${ark}"`,
    recordSchema,
    maximumRecords: SRU_SINGLE_RECORD,
  }
}

const IMAGE_LIKE_DOC_TYPES: ReadonlySet<string> = new Set(INGESTION_IMAGE_LIKE_TYPES)


// ---------------------------------------------------------------------------
// Egress (the HTTP seam)
// ---------------------------------------------------------------------------

/** One HTTP response, as every transport returns it. */
export interface BnfHttpResponse {
  status: number
  body: string
  headers: ResponseHeaders
}

/**
 * Where BnF requests leave the process. The default (`envEgress`) picks
 * broker → relay → direct from the environment; tests inject a stub so the
 * resolver runs without a network.
 */
export interface BnfEgress {
  /** True when the authenticated partner gateway is reachable (a broker is
   *  configured): proext URLs and the Presentation API manifest. */
  readonly viaPartner: boolean
  /** Base of the Presentation API (version included); needed for manifests. */
  readonly presentationBaseUrl: string | undefined
  /** GET `url`. Resolves for ANY HTTP status; rejects on transport failure. */
  getText(url: string, accept: string, signal: AbortSignal | undefined): Promise<BnfHttpResponse>
}

/** Relay responses carry no headers (the sidecar returns status + body only). */
const NO_HEADERS: ResponseHeaders = { get: () => null }

/**
 * Three transports, in priority order:
 *   1. broker (BNF_BROKER_URL) — the single egress chokepoint that owns the
 *      OAuth token + shared rate caps (broker/ service). Preferred whenever
 *      configured; supersedes the relay.
 *   2. relay (GALLICA_RELAY_URL) — curl_cffi browser-handshake sidecar for
 *      Cloudflare-gated gallica.bnf.fr. The resolver itself no longer hits
 *      gallica.bnf.fr (OAI is on oai.bnf.fr), so this rarely applies.
 *   3. direct undici — browser UA + IPv4-pinned dispatcher.
 * All three mirror the upstream status verbatim, so retry/terminal behaviour is
 * identical. A transport failure (DNS, reset, timeout) is wrapped in a transient
 * BnfMcpError so callers can tell it from a programming error; a caller abort
 * is rethrown untouched.
 */
function envEgress(dispatcher: Agent): BnfEgress {
  return {
    viaPartner: brokerUrl() !== undefined,
    presentationBaseUrl: env.BNF_IIIF_PRESENTATION_BASE_URL,
    async getText(url, accept, signal) {
      try {
        if (brokerUrl() !== undefined) {
          return await brokerGetText(url, accept, signal, BNF_HTTP_TIMEOUT_MS)
        }
        if (shouldRelay(url)) {
          const relayed = await relayGetText(url, accept, signal, BNF_HTTP_TIMEOUT_MS)
          return { ...relayed, headers: NO_HEADERS }
        }
        return await directGetText(dispatcher, url, accept, signal)
      } catch (err) {
        if (signal?.aborted || err instanceof BnfMcpError) throw err
        throw new BnfMcpError(
          `BnF transport failure for ${url}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        )
      }
    },
  }
}

/** Direct undici GET: browser UA + the shared IPv4-pinned dispatcher. */
async function directGetText(
  dispatcher: Agent,
  url: string,
  accept: string,
  signal: AbortSignal | undefined,
): Promise<BnfHttpResponse> {
  const res = await undiciFetch(url, {
    method: "GET",
    headers: { "User-Agent": BNF_USER_AGENT, Accept: accept },
    dispatcher,
    signal: withTimeout(signal, BNF_HTTP_TIMEOUT_MS),
  })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

/**
 * `Retry-After` → milliseconds, or undefined when absent or unparsable.
 * RFC 9110 allows delta-seconds or an HTTP-date; a date in the past is 0.
 * (lib/mcp/call.ts reads the delta-seconds form only, and keeps its parser
 * private; the BnF brokers and Cloudflare may send either form.)
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined
  const value = header.trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs)
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------
// The parser and node helpers are shared with the Gallica OAI record parser
// (lib/bnf/oai-record.ts), which reads by direct path; the SRU responses here
// are searched by local name (findAll).

/** Parse an SRU response; a parser failure is a transient upstream glitch. */
function parseXml(xml: string, what: string): XmlNode {
  try {
    return bnfXmlParser.parse(xml)
  } catch (e) {
    throw new BnfMcpError(
      `${what} is not parseable XML: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }
}


/** Recursively collect every node stored under `key`, at any depth. */
function findAll(root: XmlNode, key: string, out: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(root)) {
    for (const item of root) findAll(item, key, out)
  } else if (root !== null && typeof root === "object") {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      if (k === key) {
        if (Array.isArray(v)) out.push(...v)
        else out.push(v)
      }
      if (v !== null && typeof v === "object") findAll(v, key, out)
    }
  }
  return out
}

/** First text value for `key` anywhere in the tree. */
function firstText(root: XmlNode, key: string): string | undefined {
  for (const n of findAll(root, key)) {
    const t = nodeText(n)
    if (t) return t
  }
  return undefined
}

/** Trimmed, deduplicated text of every `key` node, in document order. */
function uniqueTexts(root: XmlNode, key: string): string[] {
  const out = new Set<string>()
  for (const n of findAll(root, key)) {
    const t = nodeText(n)
    if (t) out.add(t)
  }
  return [...out]
}

/** The `xml:lang` attribute of a parsed element, if any (removeNSPrefix may
 *  drop the `xml:` prefix, so check both forms). */
function langAttr(node: XmlNode): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined
  const o = node as Record<string, unknown>
  const v = o[`${XML_ATTR_PREFIX}xml:lang`] ?? o[`${XML_ATTR_PREFIX}lang`]
  return typeof v === "string" ? v : undefined
}

/**
 * Choose a doc_type from the (often multi-valued, multi-lingual) <dc:type>
 * elements of a CATALOGUE record: first prefer any value that is itself a known
 * Gallica enum key ("fascicule", "monographie", …) over the generic French
 * physical-form label, then the French label, then the first value. (Gallica
 * records are typed from their OAI typedoc setSpec instead — oai-record.ts.)
 */
function pickDocType(root: XmlNode): string | undefined {
  const types = findAll(root, "type")
  if (types.length === 0) return undefined
  for (const t of types) {
    const v = nodeText(t)?.trim().toLowerCase()
    if (v && v in GALLICA_DOC_TYPE) return v
  }
  const fr = types.find((t) => langAttr(t) === "fre")
  return nodeText(fr) ?? nodeText(types[0]) ?? undefined
}

/** Read a string attribute (e.g. "tag", "code") off a parsed element. */
function attrText(node: XmlNode, name: string): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined
  const v = (node as Record<string, unknown>)[`${XML_ATTR_PREFIX}${name}`]
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined
}

/**
 * First text value of `<subfield code="…">` inside the first UNIMARC
 * `<datafield tag="…">` that carries it. Used to read 856 $u / 325 $u (the
 * Gallica reproduction URL) out of a unimarcxchange SRU record.
 */
function datafieldSubfield(root: XmlNode, tag: string, code: string): string | undefined {
  for (const field of findAll(root, "datafield")) {
    if (attrText(field, "tag") !== tag) continue
    for (const sub of findAll(field, "subfield")) {
      if (attrText(sub, "code") !== code) continue
      const t = nodeText(sub)
      if (t) return t
    }
  }
  return undefined
}

/**
 * Extract a canonical digitized-Gallica ARK from a Gallica URL/URI, or null.
 * Accepts only genuine digitized families (bpt6k/btv1b/bd6t) — a `…/cb…/date`
 * periodical-collection URL or a notice echo yields null (not canonical).
 * Returns the full `ark:/12148/<id>` form.
 */
function extractGallicaArk(url: string): string | null {
  const m = url.match(/ark:\/(\d+)\/([A-Za-z0-9]+)/)
  if (!m) return null
  const [, naan, id] = m
  if (!GALLICA_ARK_FAMILY.test(id)) return null
  return `ark:/${naan}/${id}`
}

// ---------------------------------------------------------------------------
// IIIF v3 manifest helpers (JSON) — hybrid step 4 only
// ---------------------------------------------------------------------------

/** Every string in a v3 language map ({"fr":["a","b"]} → ["a","b"]); fr preferred. */
function iiifValues(v: unknown): string[] {
  if (v === null || v === undefined) return []
  if (typeof v === "string") return v.trim() ? [v.trim()] : []
  if (Array.isArray(v)) return v.flatMap(iiifValues)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    const langs = Object.keys(o)
    const pick =
      langs.find((l) => /^fr/i.test(l)) ?? langs.find((l) => l === "none") ?? langs[0]
    return pick ? iiifValues(o[pick]) : []
  }
  return []
}

/** Flatten a manifest `metadata[]` to label/value pairs. */
function parseManifestMetadata(
  manifest: unknown,
): Array<{ label: string; value: string }> {
  if (manifest === null || typeof manifest !== "object") return []
  const raw = (manifest as Record<string, unknown>).metadata
  if (!Array.isArray(raw)) return []
  const out: Array<{ label: string; value: string }> = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    const label = iiifValues(e.label)[0]
    const value = iiifValues(e.value).join(" | ")
    if (label && value) out.push({ label, value })
  }
  return out
}

/** First metadata value whose (case-insensitive) label matches any candidate. */
function metaValue(
  metadata: Array<{ label: string; value: string }>,
  labels: string[],
): string | null {
  const wanted = new Set(labels.map((l) => l.toLowerCase().trim()))
  for (const { label, value } of metadata) {
    if (wanted.has(label.toLowerCase().trim())) return value.trim() || null
  }
  return null
}

/** "78.21 %" → 78.21; undefined when unparsable or outside 0–100. */
function parseTauxOcr(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number.parseFloat(raw.replace(",", "."))
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined
}

/**
 * Page count = the number of distinct folio canvases (deduped by the `f<N>` ordre
 * in each canvas id), or undefined when the manifest has no canvas array. This is
 * the AUTHORITATIVE count — it matches the real fetchable folios (f1..fN). BnF's
 * "Nombre total de vues" note is collection-level and wildly wrong for periodical
 * issues (e.g. bpt6k268418n: 4 real folios, note says 3197).
 */
function manifestPageCount(manifest: unknown): number | undefined {
  if (manifest === null || typeof manifest !== "object") return undefined
  const items = (manifest as Record<string, unknown>).items
  if (!Array.isArray(items)) return undefined
  const hasFolioIds = items.some((c) => {
    const id = c && typeof c === "object" ? (c as Record<string, unknown>).id : null
    return typeof id === "string" && /\/f(\d+)(?:\/|$)/.test(id)
  })
  const seen = new Set<number>()
  items.forEach((c, i) => {
    const id = c && typeof c === "object" ? (c as Record<string, unknown>).id : null
    const m = typeof id === "string" ? /\/f(\d+)(?:\/|$)/.exec(id) : null
    if (hasFolioIds && !m) return // non-paginated media canvas (audio/video)
    const ordre = m ? parseInt(m[1]!, 10) : i + 1
    seen.add(ordre)
  })
  return seen.size
}

/** What the manifest decides in hybrid step 4 — and nothing else. */
interface ManifestSignals {
  /** The manifest carries a "Taux OCR" row (the label is present). */
  ocr_available: boolean
  /** Canvas count; null when the manifest has no canvas array. */
  pages: number | null
  /** Text-layer rate in percent, when the row parses to 0–100. */
  taux_ocr?: number
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Direct BnF metadata client. One shared IPv4-pinned dispatcher per instance
 * (Cloudflare rejects the IPv6 TLS handshake from here). Bounded concurrency +
 * retry/backoff + per-attempt timeout mirror the MCP client.
 */
export class BnfDirectClient {
  private readonly signal: AbortSignal | undefined
  private readonly egress: BnfEgress
  private readonly retry: Pick<RetryOptions, "attempts" | "baseMs" | "capMs">

  constructor(opts?: {
    signal?: AbortSignal
    /** Test seam: replaces the broker/relay/direct transport. */
    egress?: BnfEgress
    /** Test seam: replaces the retry/backoff constants. */
    retry?: Pick<RetryOptions, "attempts" | "baseMs" | "capMs">
  }) {
    this.signal = opts?.signal
    this.egress = opts?.egress ?? envEgress(new Agent({ connect: { family: 4 } }))
    this.retry = opts?.retry ?? {
      attempts: BNF_MCP_RETRY_ATTEMPTS,
      baseMs: BNF_MCP_RETRY_BASE_MS,
      capMs: BNF_MCP_RETRY_CAP_MS,
    }
  }

  /**
   * Resolve many ARKs with bounded concurrency: one entry per input ARK, in
   * input order. `mode` is required (see ResolveMode): a caller must say whether
   * the ARKs are being committed to a corpus or staged in the buffer.
   *
   * `staged` holds cached OAI-only records (see BnfRecordService): for those
   * ARKs the OAI fetch is skipped and only the OCR rules run on the record.
   *
   * Once the client's signal aborts, ARKs not yet started are not started: each
   * settles as a failure carrying the signal's reason.
   */
  async resolveArks(
    arks: string[],
    opts: { mode: ResolveMode; staged?: ReadonlyMap<string, BnfMcpDocumentDetail> },
  ): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>> {
    const settled: Settled<BnfMcpDocumentDetail>[] = await withConcurrency(
      arks,
      async (ark) => {
        this.signal?.throwIfAborted()
        return this.resolveArk(ark, { mode: opts.mode, staged: opts.staged?.get(ark) })
      },
      BNF_DIRECT_CONCURRENCY,
    )
    return arks.map((ark, i) => {
      const s = settled[i]
      return s.ok
        ? { ark, ok: true as const, document: s.value }
        : { ark, ok: false as const, error: s.error }
    })
  }

  /** Resolve one ARK to BnfMcpDocumentDetail (the shape normalize.ts consumes). */
  async resolveArk(
    ark: string,
    opts: { mode: ResolveMode; staged?: BnfMcpDocumentDetail },
  ): Promise<BnfMcpDocumentDetail> {
    assertFullArk(ark)
    return sourceFromArk(ark) === DOCUMENT_SOURCE.CATALOGUE
      ? this.resolveCatalogue(ark)
      : this.resolveGallica(ark, opts.mode, opts.staged)
  }

  // ---- Catalogue → Gallica canonicalization ---------------------------------
  // A catalogue notice (`cb…`) is a bibliographic reference, not a consultable
  // document. When the BnF has digitized it, that digitized doc has its own
  // Gallica ARK (bpt6k…/btv1b…) — the one that actually carries pages, OCR and a
  // IIIF manifest, hence the one worth holding in the corpus and ingesting.
  // These methods map a `cb…` ARK to that digitized ARK when one exists.

  /**
   * Classify a catalogue (`cb…`) ARK against its digitized Gallica reproduction.
   *
   * Two documented routes, tried in order (cheapest/richest first):
   *   1. data.bnf.fr SPARQL — `electronicReproduction` on the notice's #about node.
   *   2. Catalogue SRU (UNIMARC) — field 856 $u, then 325 $u (periodicals).
   *
   * Distinguishes the three outcomes the UI needs:
   *   - `upgraded`      — a digitized Gallica ARK was found.
   *   - `not_digitized` — BOTH routes ran cleanly and found no reproduction.
   *   - `api_error`     — at least one route failed with a BnF error (timeout,
   *                       transport, HTTP status, unparsable body; logged) and
   *                       none produced an ARK, so absence is unconfirmed → a
   *                       later retry may succeed.
   *
   * Only BnfMcpError is classified. Anything else (a caller abort, a programming
   * error) is rethrown: an `api_error` verdict would hide it behind a retry.
   */
  async classifyCanonical(ark: string): Promise<CanonicalizeOutcome> {
    assertFullArk(ark)
    const routes = [
      ["sparql", () => this.canonicalViaSparql(ark)],
      ["unimarc", () => this.canonicalViaUnimarc(ark)],
    ] as const
    let apiError = false
    for (const [route, lookup] of routes) {
      try {
        const g = await lookup()
        if (g) return { ark, status: CANONICAL_OUTCOME_STATUS.UPGRADED, canonical: g }
      } catch (err) {
        if (!(err instanceof BnfMcpError)) throw err
        console.warn(`[bnf-direct] canonical via ${route} failed`, { ark, err })
        apiError = true
      }
    }
    // Neither route produced an ARK. If a route errored we cannot trust the
    // "absent" verdict — treat it as retryable rather than "not on Gallica".
    return {
      ark,
      status: apiError
        ? CANONICAL_OUTCOME_STATUS.API_ERROR
        : CANONICAL_OUTCOME_STATUS.NOT_DIGITIZED,
    }
  }

  /**
   * Classify each catalogue notice in `arks` against its digitized Gallica
   * reproduction, with bounded concurrency. Returns one outcome per `cb…` ARK
   * (non-catalogue ARKs are skipped — they need no canonicalization).
   */
  async canonicalizeArks(arks: string[]): Promise<CanonicalizeOutcome[]> {
    const cbArks = arks.filter((a) => sourceFromArk(a) === DOCUMENT_SOURCE.CATALOGUE)
    if (cbArks.length === 0) return []

    const settled: Settled<CanonicalizeOutcome>[] = await withConcurrency(
      cbArks,
      async (ark) => {
        this.signal?.throwIfAborted()
        return this.classifyCanonical(ark)
      },
      BNF_DIRECT_CONCURRENCY,
    )
    // classifyCanonical rethrows what is not a BnF error, and withConcurrency
    // wraps that (and an abort) per ARK. Absence stays unconfirmed → api_error,
    // but the cause is logged so it is never silent.
    return cbArks.map((ark, i) => {
      const s = settled[i]
      if (s.ok) return s.value
      console.warn("[bnf-direct] canonicalize failed", { ark, err: s.error })
      return { ark, status: CANONICAL_OUTCOME_STATUS.API_ERROR }
    })
  }

  /** Route 1: data.bnf.fr SPARQL — `electronicReproduction`. */
  private async canonicalViaSparql(ark: string): Promise<string | null> {
    // data.bnf.fr resource URIs MUST be http:// (https:// yields zero results).
    const query =
      `SELECT ?gallica WHERE { ` +
      `<http://data.bnf.fr/${ark}#about> ` +
      `<${ELECTRONIC_REPRODUCTION}> ?gallica } LIMIT 1`
    const body = await this.httpGetText(
      this.egress.viaPartner ? DATABNF_SPARQL.proext : DATABNF_SPARQL.ungated,
      { query, format: "json" },
      "application/sparql-results+json",
    )
    let parsed: { results?: { bindings?: Array<{ gallica?: { value?: string } }> } }
    try {
      parsed = JSON.parse(body)
    } catch (e) {
      throw new BnfMcpError(
        `data.bnf.fr SPARQL response is not valid JSON for ${ark}: ${e instanceof Error ? e.message : String(e)}`,
        e,
      )
    }
    const value = parsed.results?.bindings?.[0]?.gallica?.value
    return value ? extractGallicaArk(value) : null
  }

  /** Route 2: Catalogue SRU (UNIMARC) — field 856 $u, then 325 $u. */
  private async canonicalViaUnimarc(ark: string): Promise<string | null> {
    const cat = this.egress.viaPartner ? CATALOGUE_SRU.proext : CATALOGUE_SRU.ungated
    const xml = await this.httpGetText(cat.url, catalogueSruParams(ark, cat.unimarc))
    const root = parseXml(xml, `Catalogue SRU (UNIMARC) response for ${ark}`)
    const url =
      datafieldSubfield(root, "856", "u") ?? datafieldSubfield(root, "325", "u")
    return url ? extractGallicaArk(url) : null
  }

  // ---- Gallica metadata: the hybrid resolver --------------------------------
  // See the header for the four rules. `mode` only decides whether rule 4 (the
  // manifest) may run.
  private async resolveGallica(
    ark: string,
    mode: ResolveMode,
    staged?: BnfMcpDocumentDetail,
  ): Promise<BnfMcpDocumentDetail> {
    const oai = staged ?? (await this.fetchOaiRecord(ark))
    const base: BnfMcpDocumentDetail = {
      ...oai,
      pages_source: oai.oai_total_views !== undefined ? PAGES_SOURCE.OAI : null,
    }

    // Rule 2: OAI marks a text layer. 100 % precise, so no manifest call.
    if (oai.ocr_available === true) return { ...base, ocr_source: OCR_SOURCE.OAI }

    // Staging stops here: OAI silence is left as "unknown" (ocr_available unset).
    if (mode === RESOLVE_MODE.STAGING) return base

    // Rule 3: an image-like document has no native text either way; the flag is
    // irrelevant to its lanes, so don't spend a manifest call on it.
    if (isImageLike(oai)) {
      return { ...base, ocr_available: false, ocr_source: OCR_SOURCE.IMAGE_LIKE }
    }

    // No broker (dev): the Presentation API needs credentials only the broker
    // holds, so the manifest is unreachable. OAI silence proves nothing (it
    // misses the text layer of every OCR'd press issue), so the verdict stays
    // UNKNOWN (null) — never false, which would route the document to paid OCR.
    if (!this.egress.viaPartner) {
      return { ...base, ocr_available: null, ocr_source: OCR_SOURCE.OAI }
    }

    // Rule 4: a text-like document OAI is silent on. The manifest decides.
    let signals: ManifestSignals
    try {
      signals = await this.fetchManifestSignals(ark)
    } catch (err) {
      // Not-found is terminal for the manifest but not for the document: OAI
      // knows it. The text-layer verdict stays UNKNOWN (null) — never false,
      // which would route the document to paid OCR. Anything else (transient,
      // auth, rate limit) propagates so the resolver retries with backoff.
      if (!(err instanceof BnfMcpNotFoundError)) throw err
      console.warn("[bnf-direct] manifest not found", { ark })
      return { ...base, ocr_available: null }
    }
    return {
      ...base,
      ocr_available: signals.ocr_available,
      ocr_source: OCR_SOURCE.MANIFEST,
      ...(signals.pages !== null ? { pages: signals.pages, pages_source: PAGES_SOURCE.MANIFEST } : {}),
      ...(signals.taux_ocr !== undefined ? { taux_ocr: signals.taux_ocr } : {}),
    }
  }

  /** GET + parse the Gallica OAI-PMH record (external bucket). */
  private async fetchOaiRecord(ark: string): Promise<BnfMcpDocumentDetail> {
    const xml = await this.httpGetText(GALLICA_OAI_PMH_URL, {
      verb: "GetRecord",
      metadataPrefix: "oai_dc",
      identifier: `oai:bnf.fr:gallica/${ark}`,
    })
    return parseGallicaOaiRecord(xml, ark)
  }

  /**
   * GET the IIIF v3 manifest from the Presentation API (broker `manifest`
   * bucket) and read ONLY the OCR flag, the canvas count and the OCR rate.
   * Throws BnfMcpNotFoundError on a 404, a transient BnfMcpError otherwise.
   */
  private async fetchManifestSignals(ark: string): Promise<ManifestSignals> {
    const presentationBase = this.egress.presentationBaseUrl
    if (presentationBase === undefined) {
      // lib/env.ts refuses to boot with a broker and no Presentation base, and
      // this path runs only with a broker — reaching here means that invariant
      // broke. Fail the resolution loudly, never guess a URL.
      throw new BnfMcpError(
        "broker configured without the Presentation base (BNF_IIIF_PRESENTATION_BASE_URL)",
      )
    }
    const body = await this.httpGetText(
      presentationManifestUrl(presentationBase, ark),
      {},
      "application/json, application/ld+json",
    )
    let manifest: unknown
    try {
      manifest = JSON.parse(body)
    } catch (e) {
      // A live manifest is valid JSON; a parse failure is a transient upstream
      // glitch (truncated body / error page), not a terminal per-doc condition.
      throw new BnfMcpError(
        `Gallica manifest is not valid JSON for ${ark}: ${e instanceof Error ? e.message : String(e)}`,
        e,
      )
    }
    const tauxOcr = metaValue(parseManifestMetadata(manifest), TAUX_OCR_LABELS)
    const taux = parseTauxOcr(tauxOcr)
    return {
      ocr_available: tauxOcr !== null,
      pages: manifestPageCount(manifest) ?? null,
      ...(taux !== undefined ? { taux_ocr: taux } : {}),
    }
  }

  // ---- Catalogue: SRU -------------------------------------------------------
  private async resolveCatalogue(ark: string): Promise<BnfMcpDocumentDetail> {
    const cat = this.egress.viaPartner ? CATALOGUE_SRU.proext : CATALOGUE_SRU.ungated
    const xml = await this.httpGetText(cat.url, catalogueSruParams(ark, cat.dc))
    const root = parseXml(xml, `Catalogue SRU response for ${ark}`)

    const title = firstText(root, "title")
    if (!title) {
      throw new BnfMcpNotFoundError(`Catalogue SRU returned no record for ${ark}`)
    }
    const subject = uniqueTexts(root, "subject")

    return {
      ark: localArk(ark),
      title,
      author: firstText(root, "creator"),
      date: firstText(root, "date"),
      doc_type: pickDocType(root),
      language: firstText(root, "language"),
      publisher: firstText(root, "publisher"),
      ...(subject.length > 0 ? { subject } : {}),
      catalogue_url: `http://catalogue.bnf.fr/${ark}`,
    }
  }

  // ---- transport ------------------------------------------------------------
  // The egress picks the transport (broker → relay → direct) and mirrors the
  // upstream status verbatim, so retry/terminal behaviour is identical on all
  // three. The caller's signal bounds the retry loop too: once it aborts, no
  // attempt starts and no backoff is waited out.
  private async httpGetText(
    baseUrl: string,
    query: Record<string, string>,
    accept = "application/xml",
  ): Promise<string> {
    const url = `${baseUrl}?${new URLSearchParams(query).toString()}`
    return withRetry(
      async () => {
        const { status, body, headers } = await this.egress.getText(url, accept, this.signal)
        return this.classifyResponse(url, status, body, headers)
      },
      { ...this.retry, signal: this.signal },
    )
  }

  /** Map an HTTP status to the shared BnF error taxonomy, or return the body on
   *  2xx. Applied identically to every transport's response. A 429 carries the
   *  upstream `Retry-After` so withRetry waits the real delay. */
  private classifyResponse(
    url: string,
    status: number,
    body: string,
    headers: ResponseHeaders,
  ): string {
    if (status === 401 || status === 403) {
      // 403 from Cloudflare (UA/fingerprint, or a rejected relay handshake).
      // Terminal — retrying the same call won't help.
      throw new BnfMcpAuthError(`BnF HTTP ${status} for ${url}`)
    }
    if (status === 404) {
      throw new BnfMcpNotFoundError(`BnF HTTP 404 for ${url}`)
    }
    if (status === 429) {
      throw new BnfMcpRateLimitError(
        "BnF direct rate limited",
        parseRetryAfter(headers.get("retry-after"), Date.now()),
      )
    }
    if (status < 200 || status >= 300) {
      throw new BnfMcpError(`BnF HTTP ${status} for ${url}`)
    }
    return body
  }
}

/**
 * Whether the record's docType (the same mapping normalize applies: typedoc,
 * else dc:type) is one of the image-like ingestion types.
 */
function isImageLike(oai: BnfMcpDocumentDetail): boolean {
  const docType = normalizeDocument(oai)?.docType
  return docType !== undefined && IMAGE_LIKE_DOC_TYPES.has(docType)
}
