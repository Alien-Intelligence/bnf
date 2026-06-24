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
//              → Dublin Core (oai_dc). UNGATED (no auth, no Cloudflare, no
//                partner quota). OCR availability = the "Avec mode texte"
//                description flag (replaces the old <nqamoyen> score); page
//                count = the "Nombre total de vues" format note. The new BnF
//                IIIF v3 manifest itself points here via seeAlso.
//   Catalogue: GET http://catalogue.bnf.fr/api/SRU ... bib.persistentId all "<ark>"
//              recordSchema=dublincore → Dublin Core.
//
// Returns the SAME shape as BnfMcpClient.resolveArks so the resolver and the
// normalize layer (lib/mcp/normalize.ts) are unchanged. Search stays on the MCP
// (in-band, agent-driven); only resolution moved here.
import "server-only"

import { XMLParser } from "fast-xml-parser"
import { Agent, fetch as undiciFetch } from "undici"

import {
  BNF_DIRECT_CONCURRENCY,
  BNF_HTTP_TIMEOUT_MS,
  BNF_MCP_RETRY_ATTEMPTS,
  BNF_MCP_RETRY_BASE_MS,
  BNF_MCP_RETRY_CAP_MS,
  BNF_USER_AGENT,
} from "@/lib/constants"
import { brokerGetText, brokerUrl } from "@/lib/bnf/broker-client"
import { relayGetText, shouldRelay } from "@/lib/bnf/gallica-relay"
import { withTimeout } from "@/lib/mcp/abort"
import type {
  BnfMcpDocumentDetail,
  BnfMcpResolveError,
  BnfMcpResolveResult,
} from "@/lib/mcp/bnf-client"
import {
  BnfMcpAuthError,
  BnfMcpError,
  BnfMcpNotFoundError,
  BnfMcpRateLimitError,
} from "@/lib/mcp/errors"
import { type Settled, withConcurrency, withRetry } from "@/lib/mcp/retry"
import { sourceFromArk } from "@/lib/mcp/vocab"

/**
 * Outcome of classifying a catalogue (`cb…`) ARK against its digitized Gallica
 * reproduction. `upgraded` carries the digitized ARK to substitute; the other
 * two record why the notice stayed a notice (see Document.canonicalStatus).
 */
export type CanonicalizeOutcome =
  | { ark: string; status: "upgraded"; canonical: string }
  | { ark: string; status: "not_digitized" }
  | { ark: string; status: "api_error" }

// Ungated OAI-PMH metadata endpoint (oai.bnf.fr) — NOT gallica.bnf.fr, which is
// Cloudflare-403'd from the server. No auth, no partner quota, no Cloudflare.
const GALLICA_OAI_PMH_URL = "http://oai.bnf.fr/oai2/OAIHandler"
const CATALOGUE_SRU_URL = "http://catalogue.bnf.fr/api/SRU"
const DATABNF_SPARQL_URL = "https://data.bnf.fr/sparql"

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

/** ARK short form: strip the `ark:/<naan>/` prefix. */
function localArk(ark: string): string {
  return ark.replace(/^ark:\/\d+\//, "")
}
/** Full canonical ARK form. */
function fullArk(ark: string): string {
  return ark.startsWith("ark:/") ? ark : `ark:/12148/${ark}`
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------
// removeNSPrefix turns <dc:title> → "title" and the <oai_dc:dc>/<srw:*> wrappers
// into plain keys, so we navigate by local name. Attributes are kept (we need
// xml:lang on <dc:type> to prefer the French label). Values stay strings.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
})

type XmlNode = unknown

/** Coerce a parsed node (string | number | {#text,attrs} | array) to text. */
function nodeText(node: XmlNode): string | null {
  if (node === null || node === undefined) return null
  if (typeof node === "string") return node.trim() || null
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = nodeText(n)
      if (t) return t
    }
    return null
  }
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return nodeText((node as Record<string, unknown>)["#text"])
  }
  return null
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

/** The `xml:lang` attribute of a parsed element, if any (removeNSPrefix may
 *  drop the `xml:` prefix, so check both forms). */
function langAttr(node: XmlNode): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined
  const o = node as Record<string, unknown>
  const v = o["@_xml:lang"] ?? o["@_lang"]
  return typeof v === "string" ? v : undefined
}

/**
 * Choose a doc_type from the (often multi-valued, multi-lingual) <dc:type>
 * elements. Prefer the French label ("monographie imprimée", "texte imprimé"),
 * which normalize.ts maps to a real type; the English "text" maps to "other".
 */
function pickDocType(root: XmlNode): string | undefined {
  const types = findAll(root, "type")
  if (types.length === 0) return undefined
  const fr = types.find((t) => langAttr(t) === "fre")
  return nodeText(fr) ?? nodeText(types[0]) ?? undefined
}

/**
 * True if any <dc:description> announces a text layer ("Avec mode texte").
 * BnF's OAI marks OCR'd documents this way; it is the migration replacement for
 * the old <nqamoyen> score as the OCR-availability signal (verified live: present
 * on text docs, absent on image-only docs). See ai-memories partner-api-migration.
 */
function hasTextMode(root: XmlNode): boolean {
  return findAll(root, "description").some((n) => {
    const t = nodeText(n)
    return t !== null && /mode\s+texte/i.test(t)
  })
}

/** Total view (page/folio) count from <dc:format>"Nombre total de vues : N". */
function totalViews(root: XmlNode): number | undefined {
  for (const n of findAll(root, "format")) {
    const m = nodeText(n)?.match(/Nombre total de vues\s*:\s*(\d+)/i)
    if (m) return Number(m[1])
  }
  return undefined
}

/** Read a string attribute (e.g. "tag", "code") off a parsed element. */
function attrText(node: XmlNode, name: string): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined
  const v = (node as Record<string, unknown>)[`@_${name}`]
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
// Client
// ---------------------------------------------------------------------------

/**
 * Direct BnF metadata client. One shared IPv4-pinned dispatcher per instance
 * (Cloudflare rejects the IPv6 TLS handshake from here). Bounded concurrency +
 * retry/backoff + per-attempt timeout mirror the MCP client.
 */
export class BnfDirectClient {
  private readonly signal: AbortSignal | undefined
  private readonly dispatcher: Agent

  constructor(opts?: { signal?: AbortSignal }) {
    this.signal = opts?.signal
    this.dispatcher = new Agent({ connect: { family: 4 } })
  }

  /** Resolve many ARKs with bounded concurrency. Same contract & ordering as
   *  BnfMcpClient.resolveArks: one entry per input ARK, in input order. */
  async resolveArks(
    arks: string[],
  ): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>> {
    const settled: Settled<BnfMcpDocumentDetail>[] = await withConcurrency(
      arks,
      (ark) => this.resolveArk(ark),
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
  async resolveArk(ark: string): Promise<BnfMcpDocumentDetail> {
    return sourceFromArk(ark) === "catalogue"
      ? this.resolveCatalogue(ark)
      : this.resolveGallica(ark)
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
   *   - `api_error`     — at least one route threw (timeout/transport/parse) and
   *                       none produced an ARK, so absence is unconfirmed → a
   *                       later retry may succeed.
   * Never throws.
   */
  async classifyCanonical(ark: string): Promise<CanonicalizeOutcome> {
    let apiError = false
    try {
      const g = await this.canonicalViaSparql(ark)
      if (g) return { ark, status: "upgraded", canonical: g }
    } catch {
      apiError = true
    }
    try {
      const g = await this.canonicalViaUnimarc(ark)
      if (g) return { ark, status: "upgraded", canonical: g }
    } catch {
      apiError = true
    }
    // Neither route produced an ARK. If a route errored we cannot trust the
    // "absent" verdict — treat it as retryable rather than "not on Gallica".
    return { ark, status: apiError ? "api_error" : "not_digitized" }
  }

  /**
   * Classify each catalogue notice in `arks` against its digitized Gallica
   * reproduction, with bounded concurrency. Returns one outcome per `cb…` ARK
   * (non-catalogue ARKs are skipped — they need no canonicalization).
   */
  async canonicalizeArks(arks: string[]): Promise<CanonicalizeOutcome[]> {
    const cbArks = arks.filter((a) => sourceFromArk(a) === "catalogue")
    if (cbArks.length === 0) return []

    const settled: Settled<CanonicalizeOutcome>[] = await withConcurrency(
      cbArks,
      (ark) => this.classifyCanonical(ark),
      BNF_DIRECT_CONCURRENCY,
    )
    // classifyCanonical never throws, but withConcurrency wraps regardless; a
    // wrapped rejection is the same unconfirmed-absence case → api_error.
    return cbArks.map((ark, i) => {
      const s = settled[i]
      return s.ok ? s.value : { ark, status: "api_error" as const }
    })
  }

  /** Route 1: data.bnf.fr SPARQL — `electronicReproduction`. */
  private async canonicalViaSparql(ark: string): Promise<string | null> {
    // data.bnf.fr resource URIs MUST be http:// (https:// yields zero results).
    const query =
      `SELECT ?gallica WHERE { ` +
      `<http://data.bnf.fr/${fullArk(ark)}#about> ` +
      `<${ELECTRONIC_REPRODUCTION}> ?gallica } LIMIT 1`
    const body = await this.httpGetText(
      DATABNF_SPARQL_URL,
      { query, format: "json" },
      "application/sparql-results+json",
    )
    const parsed = JSON.parse(body) as {
      results?: { bindings?: Array<{ gallica?: { value?: string } }> }
    }
    const value = parsed.results?.bindings?.[0]?.gallica?.value
    return value ? extractGallicaArk(value) : null
  }

  /** Route 2: Catalogue SRU (UNIMARC) — field 856 $u, then 325 $u. */
  private async canonicalViaUnimarc(ark: string): Promise<string | null> {
    const xml = await this.httpGetText(CATALOGUE_SRU_URL, {
      version: "1.2",
      operation: "searchRetrieve",
      query: `bib.persistentId all "${fullArk(ark)}"`,
      recordSchema: "unimarcxchange",
      maximumRecords: "1",
    })
    const root = parser.parse(xml)
    const url =
      datafieldSubfield(root, "856", "u") ?? datafieldSubfield(root, "325", "u")
    return url ? extractGallicaArk(url) : null
  }

  // ---- Gallica: OAI-PMH (oai.bnf.fr) ----------------------------------------
  private async resolveGallica(ark: string): Promise<BnfMcpDocumentDetail> {
    // Metadata from the UNGATED OAI-PMH endpoint (oai.bnf.fr) — no auth, no
    // Cloudflare, no partner quota — NOT gallica.bnf.fr/services/OAIRecord
    // (Cloudflare-403 from the server). OCR availability is the "Avec mode
    // texte" flag (replaces the old <nqamoyen> score); page count is the
    // "Nombre total de vues" note. See ai-memories partner-api-migration.
    const xml = await this.httpGetText(GALLICA_OAI_PMH_URL, {
      verb: "GetRecord",
      metadataPrefix: "oai_dc",
      identifier: `oai:bnf.fr:gallica/${fullArk(ark)}`,
    })
    const root = parser.parse(xml)

    const title = firstText(root, "title")
    if (!title) {
      // A live OAI record always carries a title; its absence (or an
      // <error code="idDoesNotExist">) means the ARK is unknown / not
      // digitized. Terminal — do not retry.
      throw new BnfMcpNotFoundError(`Gallica OAI record has no title for ${ark}`)
    }

    const pages = totalViews(root)

    return {
      ark: localArk(ark),
      title,
      creator: firstText(root, "creator"),
      date: firstText(root, "date"),
      doc_type: pickDocType(root),
      language: firstText(root, "language"),
      publisher: firstText(root, "publisher"),
      ocr_available: hasTextMode(root),
      ...(pages !== undefined ? { pages } : {}),
      gallica_url: `https://gallica.bnf.fr/${fullArk(ark)}`,
    }
  }

  // ---- Catalogue: SRU -------------------------------------------------------
  private async resolveCatalogue(ark: string): Promise<BnfMcpDocumentDetail> {
    const xml = await this.httpGetText(CATALOGUE_SRU_URL, {
      version: "1.2",
      operation: "searchRetrieve",
      query: `bib.persistentId all "${fullArk(ark)}"`,
      recordSchema: "dublincore",
      maximumRecords: "1",
    })
    const root = parser.parse(xml)

    const title = firstText(root, "title")
    if (!title) {
      throw new BnfMcpNotFoundError(`Catalogue SRU returned no record for ${ark}`)
    }

    return {
      ark: localArk(ark),
      title,
      author: firstText(root, "creator"),
      date: firstText(root, "date"),
      doc_type: pickDocType(root),
      language: firstText(root, "language"),
      publisher: firstText(root, "publisher"),
      catalogue_url: `http://catalogue.bnf.fr/${fullArk(ark)}`,
    }
  }

  // ---- transport ------------------------------------------------------------
  // Three transports, in priority order:
  //   1. broker (BNF_BROKER_URL) — the single egress chokepoint that owns the
  //      OAuth token + shared rate caps (broker/ service). Preferred whenever
  //      configured; supersedes the relay.
  //   2. relay (GALLICA_RELAY_URL) — curl_cffi browser-handshake sidecar for
  //      Cloudflare-gated gallica.bnf.fr (legacy demo stopgap; post-OAI-cutover
  //      the resolver no longer hits gallica.bnf.fr, so this rarely applies).
  //   3. direct undici — browser UA + IPv4-pinned dispatcher.
  // All three feed the same status classification (each transport mirrors the
  // upstream status verbatim), so retry/terminal behaviour is identical.
  private async httpGetText(
    baseUrl: string,
    query: Record<string, string>,
    accept = "application/xml",
  ): Promise<string> {
    const url = `${baseUrl}?${new URLSearchParams(query).toString()}`
    const viaBroker = brokerUrl() !== undefined
    const viaRelay = !viaBroker && shouldRelay(url)
    return withRetry(
      async () => {
        const { status, body } = viaBroker
          ? await brokerGetText(url, accept, this.signal, BNF_HTTP_TIMEOUT_MS)
          : viaRelay
            ? await relayGetText(url, accept, this.signal, BNF_HTTP_TIMEOUT_MS)
            : await this.directGetText(url, accept)
        return this.classifyResponse(url, status, body)
      },
      {
        attempts: BNF_MCP_RETRY_ATTEMPTS,
        baseMs: BNF_MCP_RETRY_BASE_MS,
        capMs: BNF_MCP_RETRY_CAP_MS,
      },
    )
  }

  /** Direct undici GET: browser UA + the shared IPv4-pinned dispatcher. */
  private async directGetText(
    url: string,
    accept: string,
  ): Promise<{ status: number; body: string }> {
    const res = await undiciFetch(url, {
      method: "GET",
      headers: { "User-Agent": BNF_USER_AGENT, Accept: accept },
      dispatcher: this.dispatcher,
      signal: withTimeout(this.signal, BNF_HTTP_TIMEOUT_MS),
    })
    return { status: res.status, body: await res.text() }
  }

  /** Map an HTTP status to the shared BnF error taxonomy, or return the body on
   *  2xx. Applied identically to direct and relayed responses. */
  private classifyResponse(url: string, status: number, body: string): string {
    if (status === 401 || status === 403) {
      // 403 from Cloudflare (UA/fingerprint, or a rejected relay handshake).
      // Terminal — retrying the same call won't help.
      throw new BnfMcpAuthError(`BnF HTTP ${status} for ${url}`)
    }
    if (status === 404) {
      throw new BnfMcpNotFoundError(`BnF HTTP 404 for ${url}`)
    }
    if (status === 429) {
      throw new BnfMcpRateLimitError("BnF direct rate limited")
    }
    if (status < 200 || status >= 300) {
      throw new BnfMcpError(`BnF HTTP ${status} for ${url}`)
    }
    return body
  }
}
