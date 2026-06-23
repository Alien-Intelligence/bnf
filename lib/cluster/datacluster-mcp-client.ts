import "server-only"
// lib/cluster/datacluster-mcp-client.ts
// Direct HTTP client for the data-cluster MCP (mcp-datacluster, mcp-base).
//
// Streamable-HTTP / JSON-RPC 2.0, identical transport shape to the BnF MCP:
//   - stateful server → `initialize` returns an `Mcp-Session-Id` header that
//     every subsequent request must echo (a bare call → `400 Missing session ID`);
//   - tool results arrive as a JSON string inside `result.content[0].text`;
//   - the response may be `application/json` or `text/event-stream` (SSE).
//
// It powers REAL RAG for the research agent (CLUSTER_MODE=real). The only two
// tools the app needs are exposed here:
//   - listDatasets()          → resolve a project's dataset (slug `bnf-<id>`);
//   - vectorSearchChunks(...)  → semantic search returning ARK+folio chunks.
//
// Auth: opaque service Bearer token (CLUSTER_BEARER_TOKEN). The mcp-base layer
// relays it upstream as the OAuth access token.
//
// This is a sibling of lib/mcp/bnf-client.ts; it reuses the *generic* transport
// helpers (withTimeout, withRetry) but keeps its own error taxonomy so the BnF
// and data-cluster boundaries stay crisp. See ai_docs/plans/datacluster-mcp-rag.md.

import {
  DATACLUSTER_MCP_RETRY_ATTEMPTS,
  DATACLUSTER_MCP_RETRY_BASE_MS,
  DATACLUSTER_MCP_RETRY_CAP_MS,
  DATACLUSTER_MCP_TIMEOUT_MS,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from "@/lib/constants"
import { requireClusterEnv } from "@/lib/env"
import { withTimeout } from "@/lib/mcp/abort"
import { withRetry } from "@/lib/mcp/retry"

// ---------------------------------------------------------------------------
// Error taxonomy (own — not the BnF MCP's)
// ---------------------------------------------------------------------------

/** Base class for all data-cluster MCP failures. */
export class DataclusterMcpError extends Error {
  constructor(
    message: string,
    public override cause?: unknown,
  ) {
    super(message)
    this.name = "DataclusterMcpError"
  }
}

/** HTTP 401 / 403 — bearer token missing, expired, or rejected. Terminal. */
export class DataclusterMcpAuthError extends DataclusterMcpError {
  constructor(m = "data-cluster MCP auth failed") {
    super(m)
    this.name = "DataclusterMcpAuthError"
  }
}

/** HTTP 404 / unknown id — terminal: retrying cannot help. */
export class DataclusterMcpNotFoundError extends DataclusterMcpError {
  constructor(m = "data-cluster MCP resource not found") {
    super(m)
    this.name = "DataclusterMcpNotFoundError"
  }
}

/**
 * The tool ran but returned a tool-level error (`result.isError`), e.g. an
 * invalid filter. Terminal: the input is deterministic, so retrying is futile —
 * and unlike a transport blip, the message is the cluster's own and must reach
 * the caller verbatim (not be masked as a JSON parse error).
 */
export class DataclusterMcpToolError extends DataclusterMcpError {
  constructor(m: string) {
    super(m)
    this.name = "DataclusterMcpToolError"
  }
}

/** Auth, not-found, and tool-level errors are terminal; everything else
 *  (429/5xx/transport) retries. */
function isTerminal(err: unknown): boolean {
  return (
    err instanceof DataclusterMcpAuthError ||
    err instanceof DataclusterMcpNotFoundError ||
    err instanceof DataclusterMcpToolError
  )
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * The mcp-datacluster success envelope, returned as a JSON string inside
 * `result.content[0].text`:
 *   success → { success: true,  data: <payload> }
 *   failure → { success: false, error: "…" }
 * A logical failure is delivered with HTTP 200, so it is detected from the body.
 */
interface DataclusterEnvelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** One dataset as returned by `datacluster_list_datasets`. */
export interface DataclusterDataset {
  id: number
  name: string
  slug: string
  entry_count: number
}

interface ListDatasetsData {
  datasets: DataclusterDataset[]
}

/** One chunk hit from `datacluster_vector_search_chunks`. */
export interface DataclusterChunk {
  id: string
  score: number
  chunk_text: string
  metadata: {
    ark?: string
    folio?: number
    char_start?: number
    char_end?: number
    entry_id?: number
    dataset_id?: number
    chunk_index?: number
    docType?: string
    [key: string]: unknown
  }
}

interface VectorSearchData {
  results: DataclusterChunk[]
  total: number
}

export interface VectorSearchChunksInput {
  query: string
  limit?: number
  offset?: number
  scoreThreshold?: number
  datasetIds?: number[]
  entryIds?: number[]
}

/** One snippet inside a keyword-search hit. */
export interface DataclusterSnippet {
  field: string
  text: string
}

/** One entry-level hit from `datacluster_keyword_search`. */
export interface DataclusterKeywordHit {
  entry_id: number
  dataset_id: number
  score: number
  snippets?: DataclusterSnippet[]
  metadata?: {
    ark?: string
    title?: string
    date?: string
    docType?: string
    lang?: string
    source?: string
    [key: string]: unknown
  }
}

interface KeywordSearchData {
  results: DataclusterKeywordHit[]
  pagination?: { total?: number }
}

export interface KeywordSearchInput {
  query: string
  limit?: number
  offset?: number
  datasetIds?: number[]
  /** Exact-match filters on the dataset metadata schema (docType/lang/source/…). */
  metadataFilters?: Record<string, string | number | string[]>
}

/** Slice of an entry's processed text from `datacluster_get_entry_content`. */
export interface DataclusterEntryContent {
  entry_id: number
  text: string
  char_offset: number
  char_limit: number
  total_length: number
  has_more: boolean
  next_offset: number
}

export interface GetEntryContentInput {
  entryId: number
  charOffset?: number
  charLimit?: number
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope (internal)
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
// DataclusterMcpClient
// ---------------------------------------------------------------------------

export class DataclusterMcpClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly signal: AbortSignal | undefined

  /** Shared `initialize` handshake; reset to null on a session error to re-init. */
  private sessionPromise: Promise<string> | null = null

  constructor(opts?: { signal?: AbortSignal }) {
    const env = requireClusterEnv()
    this.baseUrl = env.DATACLUSTER_MCP_URL
    this.token = env.CLUSTER_BEARER_TOKEN
    this.signal = opts?.signal
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * List datasets (one page). Pass `limit`/`offset` to paginate. Used to
   * resolve a project's dataset id by slug — see RealRagRunner.
   */
  async listDatasets(limit: number, offset: number): Promise<DataclusterDataset[]> {
    const envelope = await this.callTool<DataclusterEnvelope<ListDatasetsData>>(
      "datacluster_list_datasets",
      { limit, offset, include_schema: false, response_format: "json" },
    )
    const data = this.unwrap(envelope, "datacluster_list_datasets")
    if (!Array.isArray(data.datasets)) {
      throw new DataclusterMcpError(
        "datacluster_list_datasets returned no datasets array",
      )
    }
    return data.datasets
  }

  /**
   * Semantic similarity search over chunks. Returns chunk-level hits with
   * ARK/folio in `metadata`. Filters: datasetIds, entryIds, scoreThreshold.
   */
  async vectorSearchChunks(
    input: VectorSearchChunksInput,
  ): Promise<VectorSearchData> {
    const args: Record<string, unknown> = { query: input.query }
    if (input.limit !== undefined) args.limit = input.limit
    if (input.offset !== undefined) args.offset = input.offset
    if (input.scoreThreshold !== undefined) args.score_threshold = input.scoreThreshold
    if (input.datasetIds !== undefined) args.dataset_ids = input.datasetIds
    if (input.entryIds !== undefined) args.entry_ids = input.entryIds

    const envelope = await this.callTool<DataclusterEnvelope<VectorSearchData>>(
      "datacluster_vector_search_chunks",
      args,
    )
    const data = this.unwrap(envelope, "datacluster_vector_search_chunks")
    if (!Array.isArray(data.results)) {
      throw new DataclusterMcpError(
        "datacluster_vector_search_chunks returned no results array",
      )
    }
    return data
  }

  /**
   * Full-text keyword search (MeiliSearch). Returns entry-level hits with
   * snippets and per-entry metadata (ARK, title, …). Supports exact-match
   * `metadataFilters` on the dataset schema (docType / lang / source / …).
   */
  async keywordSearch(input: KeywordSearchInput): Promise<KeywordSearchData> {
    const args: Record<string, unknown> = {
      query: input.query,
      response_format: "json",
    }
    if (input.limit !== undefined) args.limit = input.limit
    if (input.offset !== undefined) args.offset = input.offset
    if (input.datasetIds !== undefined) args.dataset_ids = input.datasetIds
    if (input.metadataFilters && Object.keys(input.metadataFilters).length > 0) {
      args.metadata_filters = input.metadataFilters
    }

    const envelope = await this.callTool<DataclusterEnvelope<KeywordSearchData>>(
      "datacluster_keyword_search",
      args,
    )
    const data = this.unwrap(envelope, "datacluster_keyword_search")
    if (!Array.isArray(data.results)) {
      throw new DataclusterMcpError(
        "datacluster_keyword_search returned no results array",
      )
    }
    return data
  }

  /**
   * Retrieve a slice of an entry's processed text. `charLimit: 0` returns the
   * full remaining text from `charOffset`; a positive limit paginates.
   */
  async getEntryContent(
    input: GetEntryContentInput,
  ): Promise<DataclusterEntryContent> {
    const args: Record<string, unknown> = { entry_id: input.entryId }
    if (input.charOffset !== undefined) args.char_offset = input.charOffset
    if (input.charLimit !== undefined) args.char_limit = input.charLimit

    const envelope = await this.callTool<DataclusterEnvelope<DataclusterEntryContent>>(
      "datacluster_get_entry_content",
      args,
    )
    const data = this.unwrap(envelope, "datacluster_get_entry_content")
    if (typeof data.text !== "string") {
      throw new DataclusterMcpError(
        "datacluster_get_entry_content returned no text",
      )
    }
    return data
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Unwrap the mcp-datacluster success envelope; throw on logical failure. */
  private unwrap<T>(envelope: DataclusterEnvelope<T>, tool: string): T {
    if (!envelope.success) {
      throw new DataclusterMcpError(
        `${tool} failed: ${envelope.error ?? "unknown error"}`,
      )
    }
    if (envelope.data === undefined) {
      throw new DataclusterMcpError(`${tool} returned success but no data`)
    }
    return envelope.data
  }

  /** Open (or reuse) the MCP session. Concurrent callers share one handshake. */
  private ensureSession(): Promise<string> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession()
    }
    return this.sessionPromise
  }

  /** Perform the `initialize` handshake; return the assigned session id. */
  private async openSession(): Promise<string> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
        },
      }),
      signal: withTimeout(this.signal, DATACLUSTER_MCP_TIMEOUT_MS),
    })

    if (res.status === 401 || res.status === 403) {
      throw new DataclusterMcpAuthError(
        `data-cluster MCP initialize auth failed (HTTP ${res.status})`,
      )
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new DataclusterMcpError(
        `data-cluster MCP initialize failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
      )
    }

    const sessionId = res.headers.get("mcp-session-id")
    if (!sessionId) {
      throw new DataclusterMcpError(
        "data-cluster MCP initialize returned no mcp-session-id header",
      )
    }
    return sessionId
  }

  /**
   * POST a JSON-RPC `tools/call`, with retry/backoff, and return the parsed
   * `result.content[0].text` payload. Handles SSE and plain-JSON transports.
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
          signal: withTimeout(this.signal, DATACLUSTER_MCP_TIMEOUT_MS),
        })

        if (res.status === 401 || res.status === 403) {
          throw new DataclusterMcpAuthError(
            `data-cluster MCP auth failed (HTTP ${res.status}) calling ${name}`,
          )
        }
        if (res.status === 404) {
          throw new DataclusterMcpNotFoundError(
            `data-cluster MCP returned 404 for tool ${name}`,
          )
        }
        if (res.status === 400) {
          // Most often a stale/expired session. Drop the cached session so the
          // retry re-initializes, then throw a retryable error.
          this.sessionPromise = null
          const body = await res.text().catch(() => "")
          throw new DataclusterMcpError(
            `data-cluster MCP HTTP 400 calling ${name}: ${body.slice(0, 200)}`,
          )
        }
        if (!res.ok) {
          // 429 / 5xx / other — retryable.
          throw new DataclusterMcpError(
            `data-cluster MCP HTTP ${res.status} calling ${name}`,
          )
        }

        const ct = res.headers.get("content-type") ?? ""
        let envelope: JsonRpcEnvelope

        if (ct.includes("text/event-stream")) {
          const text = await res.text()
          const dataLine = text.split("\n").find((l) => l.startsWith("data: "))
          if (!dataLine) {
            throw new DataclusterMcpError(
              `data-cluster MCP SSE response had no data line for ${name}`,
            )
          }
          envelope = JSON.parse(dataLine.slice(6)) as JsonRpcEnvelope
        } else {
          envelope = (await res.json()) as JsonRpcEnvelope
        }

        if ("error" in envelope) {
          throw new DataclusterMcpError(
            `data-cluster MCP JSON-RPC error for ${name}: ${envelope.error.message}`,
          )
        }

        const contentText = envelope.result?.content?.[0]?.text
        // A tool-level error returns isError + a human-readable message as the
        // content text (NOT the JSON success envelope). Surface that message
        // verbatim — JSON.parsing it would mask it as "Unexpected token …".
        if (envelope.result?.isError) {
          throw new DataclusterMcpToolError(
            `data-cluster MCP tool ${name} failed: ${contentText ?? "(no message)"}`,
          )
        }
        if (typeof contentText !== "string") {
          throw new DataclusterMcpError(
            `data-cluster MCP returned no text content for ${name}`,
          )
        }
        return JSON.parse(contentText) as T
      },
      {
        attempts: DATACLUSTER_MCP_RETRY_ATTEMPTS,
        baseMs: DATACLUSTER_MCP_RETRY_BASE_MS,
        capMs: DATACLUSTER_MCP_RETRY_CAP_MS,
        isTerminal,
      },
    )
  }
}
