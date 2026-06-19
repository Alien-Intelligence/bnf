// lib/mcp/bnf-client.ts
// Direct HTTP client for the BnF MCP (streamable HTTP / JSON-RPC 2.0).
//
// Used by:
//   - scripts/seed-from-mcp.ts  (slice 2 — real-data seeding)
//   - lib/agent/dispatch.ts     (slice 3 — corpus.add tool handler ARK resolution)
//   - lib/jobs/runner.ts        (slice 4 — ingestion IIIF manifest fetch)
//
// NOT used in-band by chat-sdk's mcpServers declaration (that is slice 3).
// See: playbook/mcp-client.md, ai-memories/…/persistence-architecture/research/bnf-mcp-contract.md

import "server-only"

import {
  BNF_MCP_CONCURRENCY,
  BNF_MCP_RETRY_ATTEMPTS,
  BNF_MCP_RETRY_BASE_MS,
  BNF_MCP_RETRY_CAP_MS,
  BNF_MCP_TIMEOUT_MS,
} from "@/lib/constants"
import { requireMcpEnv } from "@/lib/env"

import { withTimeout } from "./abort"
import { BnfMcpAuthError, BnfMcpError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "./errors"
import { type Settled, withConcurrency, withRetry } from "./retry"
import { openMcpSession } from "./session"
import { sourceFromArk } from "./vocab"

// ---------------------------------------------------------------------------
// MCP tool output shapes
// ---------------------------------------------------------------------------

/**
 * Shape returned by `bnf_get_document_info` (Gallica) and
 * `bnf_get_catalogue_record` (Catalogue).
 *
 * The fields listed here match the actual BnF MCP v0.2.10 dataclasses
 * (see MCPs/mcp-bnf/src/models/bnf_models.py). Remaining unknown fields are
 * captured by the index signature; normalize.ts will Zod-parse the full
 * payload from Document.rawMetadata.
 */
export interface BnfMcpDocumentDetail {
  ark: string
  title?: string
  /** Gallica documents use `creator`; Catalogue records use `author`. */
  author?: string
  creator?: string
  date?: string
  language?: string
  doc_type?: string
  subject?: string[]
  publisher?: string
  isbn?: string
  issn?: string
  catalogue_url?: string
  gallica_url?: string
  ocr_available?: boolean
  nqa_score?: number
  [key: string]: unknown
}

/**
 * The BnF MCP wraps every tool result in a success envelope:
 *   success → { success: true,  data: <payload>, … }
 *   failure → { success: false, error: "…", status_code: <http>, context: … }
 * A logical failure is returned with HTTP 200, so it must be detected from the
 * parsed body — not the transport status. See lib/mcp/bnf-client.ts unwrap.
 */
interface BnfMcpEnvelope<T> {
  success: boolean
  data?: T
  error?: string
  status_code?: number
  [key: string]: unknown
}

/** A single search result hit — short-form ark + optional metadata. */
export interface BnfMcpSearchHit {
  ark: string
  [key: string]: unknown
}

/** Paginated search result envelope shared by Gallica and Catalogue searches. */
export interface BnfMcpSearchResult {
  total: number
  hits: BnfMcpSearchHit[]
  next_cursor?: number
}

// ---------------------------------------------------------------------------
// Tool input shapes
// ---------------------------------------------------------------------------

/** Input for `bnf_search_gallica`. max 50 results per page (MCP cap). */
export interface BnfSearchGallicaInput {
  query?: string
  creator?: string
  title?: string
  subject?: string
  date?: string
  doc_type?: string
  language?: string
  start_record?: number
  maximum_records?: number
}

/** Input for `bnf_search_catalogue`. max 50 results per page (MCP cap). */
export interface BnfSearchCatalogueInput {
  query?: string
  author?: string
  title?: string
  subject?: string
  isbn?: string
  issn?: string
  date?: string
  language?: string
  start_record?: number
  maximum_records?: number
}

// ---------------------------------------------------------------------------
// resolveArks result shape
// ---------------------------------------------------------------------------

export interface BnfMcpResolveResult {
  ark: string
  ok: true
  document: BnfMcpDocumentDetail
}

export interface BnfMcpResolveError {
  ark: string
  ok: false
  error: unknown
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope types (internal)
// ---------------------------------------------------------------------------

interface JsonRpcOk {
  jsonrpc: "2.0"
  id: string
  result: {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
  }
}

interface JsonRpcErr {
  jsonrpc: "2.0"
  id: string
  error: { code: number; message: string }
}

type JsonRpcEnvelope = JsonRpcOk | JsonRpcErr

// ---------------------------------------------------------------------------
// BnfMcpClient
// ---------------------------------------------------------------------------

/**
 * Thin direct HTTP client for the BnF MCP (streamable HTTP / JSON-RPC 2.0).
 *
 * Session handshake: REQUIRED. The BnF MCP (mcp-base) is a stateful
 * Streamable-HTTP server — a call without a session id is rejected with
 * `400 Bad Request: Missing session ID`. The client lazily performs the
 * `initialize` handshake (shared across concurrent calls on one instance) and
 * echoes the resulting `Mcp-Session-Id` on every request. A 400 mid-flight
 * (session expired) drops the cached session so the next attempt re-initializes.
 * See lib/mcp/session.ts.
 *
 * Auth: long-lived service Bearer token held in BNF_MCP_TOKEN (env var).
 * Per-user OIDC tokens are a slice 6 concern.
 */
export class BnfMcpClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly signal: AbortSignal | undefined

  /** In-flight or resolved session handshake, shared across concurrent calls
   *  on this instance. Reset to null on a session error to force re-init. */
  private sessionPromise: Promise<string> | null = null

  constructor(opts?: { signal?: AbortSignal }) {
    const mcpEnv = requireMcpEnv()
    this.baseUrl = mcpEnv.BNF_MCP_URL
    this.token = mcpEnv.BNF_MCP_TOKEN
    this.signal = opts?.signal
  }

  /** Open (or reuse) the MCP session. Concurrent callers share one handshake. */
  private ensureSession(): Promise<string> {
    if (!this.sessionPromise) {
      this.sessionPromise = openMcpSession(this.baseUrl, this.token, this.signal)
    }
    return this.sessionPromise
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve a single ARK to full document metadata.
   *
   * Routing (per MCP contract research §ARK formats):
   *   cb*-prefix ARKs   → `bnf_get_catalogue_record`  (Catalogue bibliographic)
   *   Gallica-prefix    → `bnf_get_document_info`      (Gallica digitized docs)
   *
   * Throws BnfMcpNotFoundError if the ARK does not exist / is malformed in BnF.
   * Throws BnfMcpAuthError on 401/403 — not retried.
   */
  async resolveArk(ark: string): Promise<BnfMcpDocumentDetail> {
    const source = sourceFromArk(ark)
    const tool =
      source === "catalogue" ? "bnf_get_catalogue_record" : "bnf_get_document_info"
    const envelope = await this.callTool<BnfMcpEnvelope<BnfMcpDocumentDetail>>(
      tool,
      { ark },
    )
    return this.unwrapDocument(envelope, ark, tool)
  }

  /**
   * Unwrap the BnF MCP success envelope around a resolved document.
   *
   * The MCP returns logical failures (`success: false`) with HTTP 200, so the
   * transport layer (callTool) cannot detect them — we do it here. A 400/404/410
   * means the ARK doesn't resolve (bad/unknown identifier): raise the terminal
   * BnfMcpNotFoundError so the batch caller records it as a per-ARK failure
   * rather than retrying. Any other status is a transport-ish error.
   */
  private unwrapDocument(
    envelope: BnfMcpEnvelope<BnfMcpDocumentDetail>,
    ark: string,
    tool: string,
  ): BnfMcpDocumentDetail {
    if (!envelope.success) {
      const status = envelope.status_code
      const detail = envelope.error ?? "unknown error"
      const msg = `MCP ${tool} failed for ${ark}: ${detail}${status !== undefined ? ` (HTTP ${status})` : ""}`
      if (status === 400 || status === 404 || status === 410) {
        throw new BnfMcpNotFoundError(msg)
      }
      throw new BnfMcpError(msg)
    }
    if (!envelope.data || typeof envelope.data.ark !== "string") {
      throw new BnfMcpError(
        `MCP ${tool} returned success but no usable document for ${ark}`,
      )
    }
    return envelope.data
  }

  /**
   * Resolve many ARKs with bounded concurrency (BNF_MCP_CONCURRENCY = 8).
   *
   * Returns one entry per input ARK in the **same order as `arks`**:
   *   { ark, ok: true,  document }  — successful resolve
   *   { ark, ok: false, error }     — per-ARK failure (404, auth, network, …)
   *
   * Callers (seed script, corpus.add handler) decide whether to abort on
   * partial failure or continue with the successful subset.
   */
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
      if (s.ok) {
        return { ark, ok: true as const, document: s.value }
      }
      return { ark, ok: false as const, error: s.error }
    })
  }

  /**
   * Search the BnF Catalogue SRU (14M bibliographic records).
   * Maximum 50 results per page (MCP cap — pass `maximum_records` ≤ 50).
   */
  async searchCatalogue(input: BnfSearchCatalogueInput): Promise<BnfMcpSearchResult> {
    return this.callTool<BnfMcpSearchResult>("bnf_search_catalogue", input)
  }

  /**
   * Search Gallica SRU (7M digitized documents).
   * Maximum 50 results per page (MCP cap — pass `maximum_records` ≤ 50).
   */
  async searchGallica(input: BnfSearchGallicaInput): Promise<BnfMcpSearchResult> {
    return this.callTool<BnfMcpSearchResult>("bnf_search_gallica", input)
  }

  /**
   * Fetch the IIIF Presentation manifest for a Gallica document.
   * Returns the full parsed manifest (canvases, image service URLs, …).
   * Used by slice 4 ingestion and slice 5 citation side panel.
   */
  async getManifest(ark: string): Promise<unknown> {
    return this.callTool<unknown>("bnf_get_manifest", { ark })
  }

  // -------------------------------------------------------------------------
  // Private: JSON-RPC transport
  // -------------------------------------------------------------------------

  /**
   * Low-level: POST a JSON-RPC `tools/call` request, apply retry/backoff,
   * parse the text-as-JSON inner payload.
   *
   * Streamable HTTP transport may respond with `text/event-stream` (SSE) or
   * plain `application/json`. Both are handled. Reference pattern:
   * tooling/chat-sdk/src/claude/mcp-server.ts `rpc()`.
   */
  private async callTool<T>(name: string, args: unknown): Promise<T> {
    return withRetry(
      async () => {
        const id = crypto.randomUUID()
        const sessionId = await this.ensureSession()

        const res = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${this.token}`,
            "Mcp-Session-Id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
          // Bound each attempt: abort on turn cancel OR a stalled transport.
          // Computed per attempt so every retry gets a fresh deadline.
          signal: withTimeout(this.signal, BNF_MCP_TIMEOUT_MS),
        })

        // Map HTTP status codes to typed errors before reading the body.
        if (res.status === 401 || res.status === 403) {
          throw new BnfMcpAuthError(`MCP auth failed (HTTP ${res.status}) calling ${name}`)
        }
        if (res.status === 404) {
          throw new BnfMcpNotFoundError(`MCP returned 404 for tool ${name}`)
        }
        if (res.status === 400) {
          // Most often a stale/expired session ("Missing session ID"). Drop the
          // cached session so the retry re-initializes, then throw a retryable
          // error (withRetry re-runs ensureSession on the next attempt).
          this.sessionPromise = null
          const body = await res.text().catch(() => "")
          throw new BnfMcpError(
            `MCP HTTP 400 calling ${name}: ${body.slice(0, 200)}`,
          )
        }
        if (res.status === 429) {
          const retryAfterRaw = res.headers.get("retry-after")
          const retryAfterMs =
            retryAfterRaw !== null && retryAfterRaw !== ""
              ? Number(retryAfterRaw) * 1000
              : undefined
          throw new BnfMcpRateLimitError("MCP rate limited", retryAfterMs)
        }
        if (!res.ok) {
          throw new BnfMcpError(`MCP HTTP ${res.status} calling ${name}`)
        }

        // Parse the JSON-RPC envelope — SSE or plain JSON.
        const ct = res.headers.get("content-type") ?? ""
        let envelope: JsonRpcEnvelope

        if (ct.includes("text/event-stream")) {
          // Streamable HTTP: read the entire SSE body, find the first data line.
          const text = await res.text()
          const dataLine = text.split("\n").find((l) => l.startsWith("data: "))
          if (!dataLine) {
            throw new BnfMcpError(
              `MCP SSE response contained no data line for tool ${name}`,
            )
          }
          envelope = JSON.parse(dataLine.slice(6)) as JsonRpcEnvelope
        } else {
          envelope = (await res.json()) as JsonRpcEnvelope
        }

        // JSON-RPC application-level error.
        if ("error" in envelope) {
          throw new BnfMcpError(
            `MCP JSON-RPC error for ${name}: ${envelope.error.message}`,
          )
        }

        // The BnF MCP encodes the actual tool result as a JSON string inside
        // result.content[0].text (standard MCP text-content convention).
        const contentText = envelope.result?.content?.[0]?.text
        if (typeof contentText !== "string") {
          throw new BnfMcpError(
            `MCP returned no text content for tool ${name}; ` +
              `content was: ${JSON.stringify(envelope.result?.content)}`,
          )
        }

        return JSON.parse(contentText) as T
      },
      {
        attempts: BNF_MCP_RETRY_ATTEMPTS,
        baseMs: BNF_MCP_RETRY_BASE_MS,
        capMs: BNF_MCP_RETRY_CAP_MS,
      },
    )
  }
}
