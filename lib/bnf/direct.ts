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
// Endpoints (confirmed by reading MCPs/mcp-bnf and curling the live APIs):
//   Gallica:   GET https://gallica.bnf.fr/services/OAIRecord?ark=ark:/12148/<id>
//              → Dublin Core (oai_dc) + <nqamoyen> OCR score.
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
  BNF_HTTP_TIMEOUT_MS,
  BNF_MCP_CONCURRENCY,
  BNF_MCP_RETRY_ATTEMPTS,
  BNF_MCP_RETRY_BASE_MS,
  BNF_MCP_RETRY_CAP_MS,
  BNF_USER_AGENT,
} from "@/lib/constants"
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

const GALLICA_OAI_URL = "https://gallica.bnf.fr/services/OAIRecord"
const CATALOGUE_SRU_URL = "http://catalogue.bnf.fr/api/SRU"

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
      BNF_MCP_CONCURRENCY,
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

  // ---- Gallica: OAIRecord ---------------------------------------------------
  private async resolveGallica(ark: string): Promise<BnfMcpDocumentDetail> {
    const xml = await this.getXml(GALLICA_OAI_URL, {
      ark: fullArk(ark),
    })
    const root = parser.parse(xml)

    const title = firstText(root, "title")
    if (!title) {
      // A valid OAIRecord always carries a title; its absence means the ARK is
      // unknown / not digitized. Terminal — do not retry.
      throw new BnfMcpNotFoundError(`Gallica OAIRecord has no title for ${ark}`)
    }

    const nqaRaw = firstText(root, "nqamoyen")
    const nqa = nqaRaw !== undefined ? Number(nqaRaw) : NaN
    const nqaScore = Number.isFinite(nqa) ? nqa : undefined

    return {
      ark: localArk(ark),
      title,
      creator: firstText(root, "creator"),
      date: firstText(root, "date"),
      doc_type: pickDocType(root),
      language: firstText(root, "language"),
      publisher: firstText(root, "publisher"),
      nqa_score: nqaScore,
      ocr_available: nqaScore !== undefined ? nqaScore > 0 : undefined,
      gallica_url: `https://gallica.bnf.fr/${fullArk(ark)}`,
    }
  }

  // ---- Catalogue: SRU -------------------------------------------------------
  private async resolveCatalogue(ark: string): Promise<BnfMcpDocumentDetail> {
    const xml = await this.getXml(CATALOGUE_SRU_URL, {
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
  private async getXml(
    baseUrl: string,
    query: Record<string, string>,
  ): Promise<string> {
    const url = `${baseUrl}?${new URLSearchParams(query).toString()}`
    return withRetry(
      async () => {
        const res = await undiciFetch(url, {
          method: "GET",
          headers: { "User-Agent": BNF_USER_AGENT, Accept: "application/xml" },
          dispatcher: this.dispatcher,
          signal: withTimeout(this.signal, BNF_HTTP_TIMEOUT_MS),
        })
        if (res.status === 401 || res.status === 403) {
          // 403 from Cloudflare (UA/fingerprint). Terminal — retrying won't help.
          throw new BnfMcpAuthError(`BnF direct HTTP ${res.status} for ${url}`)
        }
        if (res.status === 404) {
          throw new BnfMcpNotFoundError(`BnF direct HTTP 404 for ${url}`)
        }
        if (res.status === 429) {
          throw new BnfMcpRateLimitError("BnF direct rate limited")
        }
        if (!res.ok) {
          throw new BnfMcpError(`BnF direct HTTP ${res.status} for ${url}`)
        }
        return res.text()
      },
      {
        attempts: BNF_MCP_RETRY_ATTEMPTS,
        baseMs: BNF_MCP_RETRY_BASE_MS,
        capMs: BNF_MCP_RETRY_CAP_MS,
      },
    )
  }
}
