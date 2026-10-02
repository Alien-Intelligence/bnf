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
// It powers REAL RAG for the research agent (CLUSTER_MODE=real). The tools the
// app needs are exposed here:
//   - listDatasets()          → resolve a project's dataset (slug `bnf-<id>`);
//   - vectorSearchChunks(...)  → semantic search returning ARK+folio chunks;
//   - keywordSearch(...)       → entry-level hits with metadata filters;
//   - getEntryContent(...)     → an entry's processed text, paginated or whole.
//
// Auth: opaque service Bearer token (CLUSTER_BEARER_TOKEN). The mcp-base layer
// relays it upstream as the OAuth access token.
//
// It reuses the *generic* MCP transport helpers (withTimeout, withRetry) but
// keeps its own error taxonomy so the BnF and data-cluster boundaries stay
// crisp. See ai_docs/plans/datacluster-mcp-rag.md.

import {
  DATACLUSTER_MCP_RETRY_ATTEMPTS,
  DATACLUSTER_MCP_RETRY_BASE_MS,
  DATACLUSTER_MCP_RETRY_CAP_MS,
  DATACLUSTER_MCP_TIMEOUT_MS,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from "@/lib/constants"
import { z } from "zod"
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

/**
 * The cluster answered, but not with what its contract promises: a payload
 * missing a field its mode requires, an ARK lookup returning another ARK,
 * entry text that is not in the worker's folio format. Terminal: the same
 * request returns the same bytes, so retrying is futile.
 */
export class DataclusterMcpProtocolError extends DataclusterMcpError {
  constructor(m: string, cause?: unknown) {
    super(m, cause)
    this.name = "DataclusterMcpProtocolError"
  }
}

/**
 * The request itself is wrong — HTTP 400 that is not a stale session, or a
 * JSON-RPC "method not found" / "invalid params". Terminal: resending the same
 * request gets the same answer.
 */
export class DataclusterMcpRequestError extends DataclusterMcpError {
  constructor(m: string) {
    super(m)
    this.name = "DataclusterMcpRequestError"
  }
}

/** JSON-RPC error codes that describe the request, not a transient fault. */
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602

/** An HTTP 400 body that says the MCP session is missing or expired. */
const STALE_SESSION_BODY = /session/i

/** Auth, not-found, tool-level, request and protocol errors are terminal;
 *  everything else (429/5xx/transport/stale session) retries. */
function isTerminal(err: unknown): boolean {
  return (
    err instanceof DataclusterMcpAuthError ||
    err instanceof DataclusterMcpNotFoundError ||
    err instanceof DataclusterMcpToolError ||
    err instanceof DataclusterMcpRequestError ||
    err instanceof DataclusterMcpProtocolError
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
const dataclusterEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})

/** One dataset as returned by `datacluster_list_datasets`. */
const dataclusterDatasetSchema = z
  .object({ id: z.number().int(), name: z.string(), slug: z.string(), entry_count: z.number().int() })
  .loose()
export type DataclusterDataset = z.infer<typeof dataclusterDatasetSchema>

const listDatasetsDataSchema = z.object({ datasets: z.array(dataclusterDatasetSchema) }).loose()

/**
 * One chunk hit from `datacluster_vector_search_chunks`. Metadata fields are
 * typed as the worker writes them; chunkToPassage (rag-wire.ts) decides what
 * a chunk without an ARK or offsets means.
 */
const dataclusterChunkSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    score: z.number(),
    chunk_text: z.string(),
    metadata: z
      .object({
        ark: z.string().optional(),
        folio: z.number().int().optional(),
        char_start: z.number().optional(),
        char_end: z.number().optional(),
        entry_id: z.number().int().optional(),
        dataset_id: z.number().int().optional(),
        chunk_index: z.number().int().optional(),
        docType: z.string().optional(),
        subtype: z.string().optional(),
      })
      .loose(),
  })
  .loose()
export type DataclusterChunk = z.infer<typeof dataclusterChunkSchema>

const vectorSearchDataSchema = z
  .object({ results: z.array(dataclusterChunkSchema), total: z.number().int().nonnegative() })
  .loose()
type VectorSearchData = z.infer<typeof vectorSearchDataSchema>

export interface VectorSearchChunksInput {
  query: string
  limit?: number
  offset?: number
  scoreThreshold?: number
  datasetIds?: number[]
  entryIds?: number[]
}

/** One snippet inside a keyword-search hit. */
const dataclusterSnippetSchema = z.object({ field: z.string(), text: z.string() }).loose()
export type DataclusterSnippet = z.infer<typeof dataclusterSnippetSchema>

/** One entry-level hit from `datacluster_keyword_search`. */
const dataclusterKeywordHitSchema = z
  .object({
    entry_id: z.number().int(),
    dataset_id: z.number().int(),
    score: z.number(),
    snippets: z.array(dataclusterSnippetSchema).optional(),
    metadata: z
      .object({
        ark: z.string().optional(),
        title: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
        docType: z.string().nullable().optional(),
        subtype: z.string().nullable().optional(),
        lang: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
      })
      .loose()
      .optional(),
  })
  .loose()
export type DataclusterKeywordHit = z.infer<typeof dataclusterKeywordHitSchema>

const keywordSearchDataSchema = z
  .object({
    results: z.array(dataclusterKeywordHitSchema),
    pagination: z.object({ total: z.number().int().nonnegative().optional() }).loose().optional(),
  })
  .loose()
type KeywordSearchData = z.infer<typeof keywordSearchDataSchema>

export interface KeywordSearchInput {
  query: string
  limit?: number
  offset?: number
  datasetIds?: number[]
  /** Exact-match filters on the dataset metadata schema (docType/lang/source/…). */
  metadataFilters?: Record<string, string | number | string[]>
}

/**
 * Slice of an entry's processed text from `datacluster_get_entry_content`.
 * Every offset and length is in Unicode code points (the MCP slices a Python
 * `str`; see lib/cluster/folio-text.ts).
 *
 * Only `text` is always present. In paginated mode (`char_limit > 0`) the MCP
 * adds every pagination field, with `next_offset` null on the last page. In
 * offset-only mode (`char_offset > 0`, `char_limit` 0) it adds `char_offset`,
 * `total_length` and `has_more` but no `char_limit` / `next_offset`. In full
 * mode (both 0) it returns the raw stored payload: `text`, plus whatever else
 * the storage layer kept. See MCPs/mcp-datacluster/src/tools/get_entry_content.py.
 * `toEntryContent` (rag-wire.ts) checks that each mode carries its fields.
 */
export const dataclusterEntryContentSchema = z
  .object({
    entry_id: z.number().int().positive().optional(),
    text: z.string(),
    char_offset: z.number().int().nonnegative().optional(),
    char_limit: z.number().int().nonnegative().optional(),
    total_length: z.number().int().nonnegative().optional(),
    has_more: z.boolean().optional(),
    next_offset: z.number().int().nonnegative().nullable().optional(),
  })
  .loose()
export type DataclusterEntryContent = z.infer<typeof dataclusterEntryContentSchema>

/** Offset and limit are explicit: the caller owns the default, not the MCP. */
export interface GetEntryContentInput {
  entryId: number
  charOffset: number
  charLimit: number
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope (internal)
// ---------------------------------------------------------------------------

/** A JSON-RPC error response. */
const jsonRpcErrorSchema = z
  .object({ jsonrpc: z.literal("2.0"), error: z.object({ code: z.number(), message: z.string() }).loose() })
  .loose()

/** A JSON-RPC result response to `tools/call`. */
const jsonRpcResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    result: z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string() }).loose()).optional(),
        isError: z.boolean().optional(),
      })
      .loose(),
  })
  .loose()

// ---------------------------------------------------------------------------
// DataclusterMcpClient
// ---------------------------------------------------------------------------

export class DataclusterMcpClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly signal: AbortSignal

  /** Shared `initialize` handshake; reset to null on a session error to re-init. */
  private sessionPromise: Promise<string> | null = null

  /** `signal` is required: every call this client makes is bound to its caller's lifetime. */
  constructor(opts: { signal: AbortSignal }) {
    const env = requireClusterEnv()
    this.baseUrl = env.DATACLUSTER_MCP_URL
    this.token = env.CLUSTER_BEARER_TOKEN
    this.signal = opts.signal
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * List datasets (one page). Pass `limit`/`offset` to paginate. Used to
   * resolve a project's dataset id by slug — see RealRagRunner.
   */
  async listDatasets(limit: number, offset: number): Promise<DataclusterDataset[]> {
    const data = await this.callData(
      "datacluster_list_datasets",
      { limit, offset, include_schema: false, response_format: "json" },
      listDatasetsDataSchema,
    )
    return data.datasets
  }

  /**
   * Semantic similarity search over chunks. Returns chunk-level hits with
   * ARK/folio in `metadata`. Filters: datasetIds, entryIds, scoreThreshold.
   */
  async vectorSearchChunks(input: VectorSearchChunksInput): Promise<VectorSearchData> {
    const args: Record<string, unknown> = { query: input.query }
    if (input.limit !== undefined) args.limit = input.limit
    if (input.offset !== undefined) args.offset = input.offset
    if (input.scoreThreshold !== undefined) args.score_threshold = input.scoreThreshold
    if (input.datasetIds !== undefined) args.dataset_ids = input.datasetIds
    if (input.entryIds !== undefined) args.entry_ids = input.entryIds
    return this.callData("datacluster_vector_search_chunks", args, vectorSearchDataSchema)
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
    return this.callData("datacluster_keyword_search", args, keywordSearchDataSchema)
  }

  /**
   * Retrieve a slice of an entry's processed text. `charLimit: 0` returns the
   * full remaining text from `charOffset`; a positive limit paginates.
   */
  async getEntryContent(input: GetEntryContentInput): Promise<DataclusterEntryContent> {
    return this.callData(
      "datacluster_get_entry_content",
      { entry_id: input.entryId, char_offset: input.charOffset, char_limit: input.charLimit },
      dataclusterEntryContentSchema,
    )
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Call a tool, unwrap the mcp-datacluster envelope, and parse its `data`
   * with the payload's schema. A logical failure (`success: false`) is a
   * DataclusterMcpError carrying the cluster's own message; an envelope or
   * payload that breaks its contract is a DataclusterMcpProtocolError.
   */
  private async callData<T>(tool: string, args: unknown, schema: z.ZodType<T>): Promise<T> {
    const envelope = dataclusterEnvelopeSchema.safeParse(await this.callTool(tool, args))
    if (!envelope.success) {
      throw new DataclusterMcpProtocolError(`${tool} returned a malformed envelope: ${envelope.error.message}`, envelope.error)
    }
    if (!envelope.data.success) {
      throw new DataclusterMcpError(
        envelope.data.error === undefined
          ? `${tool} failed without an error message (envelope: ${JSON.stringify(envelope.data).slice(0, 200)})`
          : `${tool} failed: ${envelope.data.error}`,
      )
    }
    if (envelope.data.data === undefined) {
      throw new DataclusterMcpProtocolError(`${tool} returned success but no data`)
    }
    const payload = schema.safeParse(envelope.data.data)
    if (!payload.success) {
      throw new DataclusterMcpProtocolError(`${tool} returned a malformed payload: ${payload.error.message}`, payload.error)
    }
    return payload.data
  }

  /**
   * Open (or reuse) the MCP session. Concurrent callers share one handshake;
   * a FAILED handshake is dropped, so the next attempt opens a new one rather
   * than re-awaiting the same rejection forever.
   */
  private ensureSession(): Promise<string> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession().catch((err: unknown) => {
        this.sessionPromise = null
        throw err
      })
    }
    return this.sessionPromise
  }

  /** The body of a failed response, for the error message; a body that cannot be read is itself reported. */
  private async failureBody(res: Response, what: string): Promise<string> {
    try {
      return (await res.text()).slice(0, 200)
    } catch (err) {
      throw new DataclusterMcpError(`${what} (HTTP ${res.status}); its body could not be read`, err)
    }
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
      const body = await this.failureBody(res, "data-cluster MCP initialize failed")
      throw new DataclusterMcpError(
        `data-cluster MCP initialize failed (HTTP ${res.status}): ${body}`,
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
   * An abort of the caller's signal is terminal: no retry, no backoff wait.
   */
  private async callTool(name: string, args: unknown): Promise<unknown> {
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
          const body = await this.failureBody(res, `data-cluster MCP HTTP 400 calling ${name}`)
          if (STALE_SESSION_BODY.test(body)) {
            // A stale/expired session: drop it so the retry re-initializes.
            this.sessionPromise = null
            throw new DataclusterMcpError(`data-cluster MCP session rejected calling ${name}: ${body}`)
          }
          throw new DataclusterMcpRequestError(`data-cluster MCP HTTP 400 calling ${name}: ${body}`)
        }
        if (!res.ok) {
          // 429 / 5xx / other — retryable, with the body for the diagnosis.
          const body = await this.failureBody(res, `data-cluster MCP HTTP ${res.status} calling ${name}`)
          throw new DataclusterMcpError(`data-cluster MCP HTTP ${res.status} calling ${name}: ${body}`)
        }

        const ct = res.headers.get("content-type")
        if (ct === null) {
          throw new DataclusterMcpProtocolError(`data-cluster MCP response for ${name} has no content-type`)
        }
        const raw = ct.includes("text/event-stream") ? sseData(await res.text(), name) : await res.text()
        const json = parseJson(raw, `JSON-RPC envelope for ${name}`)
        const rpcError = jsonRpcErrorSchema.safeParse(json)
        if (rpcError.success) {
          const { code, message } = rpcError.data.error
          const text = `data-cluster MCP JSON-RPC error ${code} for ${name}: ${message}`
          if (code === JSON_RPC_METHOD_NOT_FOUND || code === JSON_RPC_INVALID_PARAMS) {
            throw new DataclusterMcpRequestError(text)
          }
          throw new DataclusterMcpError(text)
        }
        const parsed = jsonRpcResultSchema.safeParse(json)
        if (!parsed.success) {
          throw new DataclusterMcpProtocolError(
            `data-cluster MCP returned a malformed JSON-RPC envelope for ${name}: ${parsed.error.message}`,
            parsed.error,
          )
        }
        const envelope = parsed.data

        const contentText = envelope.result.content?.[0]?.text
        // A tool-level error returns isError + a human-readable message as the
        // content text (NOT the JSON success envelope). Surface that message
        // verbatim — JSON.parsing it would mask it as "Unexpected token …".
        if (envelope.result.isError) {
          throw new DataclusterMcpToolError(
            `data-cluster MCP tool ${name} failed: ${contentText ?? "(no message)"}`,
          )
        }
        if (contentText === undefined) {
          throw new DataclusterMcpProtocolError(
            `data-cluster MCP returned no text content for ${name}`,
          )
        }
        return parseJson(contentText, `${name} result`)
      },
      {
        attempts: DATACLUSTER_MCP_RETRY_ATTEMPTS,
        baseMs: DATACLUSTER_MCP_RETRY_BASE_MS,
        capMs: DATACLUSTER_MCP_RETRY_CAP_MS,
        isTerminal,
        signal: this.signal,
      },
    )
  }
}

/** The `data:` line of a single-event SSE response. */
function sseData(text: string, tool: string): string {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "))
  if (!dataLine) {
    throw new DataclusterMcpProtocolError(`data-cluster MCP SSE response had no data line for ${tool}`)
  }
  return dataLine.slice("data: ".length)
}

/** JSON.parse that reports what it was parsing; a non-JSON reply is a protocol error. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new DataclusterMcpProtocolError(`${what} is not JSON: ${text.slice(0, 200)}`, err)
  }
}
