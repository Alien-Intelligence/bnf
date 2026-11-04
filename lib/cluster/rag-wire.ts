import "server-only"
// lib/cluster/rag-wire.ts
// The mappers between the data-cluster MCP's wire shapes and the app's RAG
// shapes. Both runners use them: RealRagRunner on what the cluster returns,
// FakeRagRunner on the chunks it builds from its fixtures in the worker's
// format — so a passage, an entry slice and an ARK lookup are shaped by the
// same code in both cluster modes.
//
// Every offset and length is in Unicode code points (lib/cluster/folio-text.ts).
// A payload that breaks its contract throws DataclusterMcpProtocolError; it is
// never patched into something that merely looks valid.

import { z } from "zod"
import { entryOrdinal } from "./composite-ids"
import { ARK_LOOKUP_LABEL, DATACLUSTER_MCP_TOOL, ENTRY_CONTENT_MODE } from "./constants"
import type { DataclusterMcpTool, EntryContentMode } from "./constants"
import type { DatasetId, EntryId } from "./composite-ids"
import { DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import type { DataclusterChunk, DataclusterEntryContent } from "./datacluster-mcp-client"
import { EntryFolioFormatError, codePointLength, foliosFromChunks, splitEntryFolios } from "./folio-text"
import type { DocumentFolios, FolioChunk } from "./folio-text"
import { RAG_LOOKUP_STATUS } from "./rag"
import type { RagEntryContent, RagPassage } from "./rag"

/**
 * Map a cluster chunk to a RagPassage. The entry id is the chunk's top-level
 * composite `entry_id` (the client schema guarantees it). Returns null when the
 * chunk carries no ARK — it cannot serve as a citation source, so it is dropped (never cited
 * without an ARK; never an invented one). Folio is preserved when present and
 * left null otherwise. The char range is set only when the chunk carries BOTH
 * offsets (worker-v2 writes them together); a chunk indexed before offsets
 * existed reports `null`, not a `[0, 0]` that would read as "the start of the
 * document". An offset pair that is not a valid range is a protocol error.
 */
export function chunkToPassage(chunk: DataclusterChunk): RagPassage | null {
  const { ark, folio, char_start, char_end } = chunk.metadata
  if (typeof ark !== "string" || ark.length === 0) return null

  return {
    ark,
    folio: positiveOrNull(ark, "folio", folio),
    snippet: chunk.chunk_text,
    score: chunk.score,
    charRange: toCharRange(ark, char_start, char_end),
    entryId: chunk.entry_id,
  }
}

/**
 * A folio (IIIF vue, ≥ 1): absent → null; present but not a positive safe
 * integer → protocol error, never passed on to the agent.
 */
function positiveOrNull(ark: string, field: string, value: unknown): number | null {
  if (value === undefined) return null
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DataclusterMcpProtocolError(`chunk of ${ark} carries an invalid ${field}: ${JSON.stringify(value)}`)
  }
  return value
}

function toCharRange(ark: string, start: unknown, end: unknown): [number, number] | null {
  if (start === undefined && end === undefined) return null
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end
  ) {
    throw new DataclusterMcpProtocolError(
      `chunk of ${ark} carries an invalid char range: char_start=${String(start)}, char_end=${String(end)}`,
    )
  }
  return [start, end]
}

/**
 * Map one `datacluster_get_entry_content` payload to the app's RagEntryContent,
 * by the mode the REQUEST selected (MCPs/mcp-datacluster/src/tools/get_entry_content.py):
 *
 *   - paginated (`charLimit > 0`): every pagination field must be present;
 *   - offset-only (`charOffset > 0`, `charLimit` 0): `char_offset`,
 *     `total_length` and `has_more` must be present;
 *   - full (both 0): the raw stored payload — the text IS the whole document,
 *     so its length is the total, nothing follows, and the next offset is its
 *     end. That is the documented meaning of the mode, not a fallback.
 *
 * A reply missing a field its mode requires is a protocol error: reading it as
 * "end of document" would silently truncate what the agent reads.
 */
export function toEntryContent(
  data: DataclusterEntryContent,
  req: { entryId: EntryId; charOffset: number; charLimit: number },
): RagEntryContent {
  const missing = (fields: Array<keyof DataclusterEntryContent>) =>
    fields.filter((f) => data[f] === undefined)

  // An echoed entry id must be the one asked for (paginated mode always
  // echoes it; the raw payload of the other modes may carry it too).
  if (data.entry_id !== undefined && data.entry_id !== req.entryId) throw inconsistent(req, data)

  if (req.charLimit > 0) {
    const { entry_id, char_offset, char_limit, total_length, has_more, next_offset } = data
    if (
      entry_id === undefined ||
      char_offset === undefined ||
      char_limit === undefined ||
      total_length === undefined ||
      has_more === undefined ||
      next_offset === undefined
    ) {
      throw incomplete(
        req,
        ENTRY_CONTENT_MODE.PAGINATED,
        missing(["entry_id", "char_offset", "char_limit", "total_length", "has_more", "next_offset"]),
      )
    }
    // The MCP echoes the request and derives the rest from the slice
    // (get_entry_content.py): end = offset + len(text) ≤ offset + limit;
    // has_more = end < total; next_offset = end while end < total, else null.
    const length = codePointLength(data.text)
    const end = char_offset + length
    if (
      char_offset !== req.charOffset ||
      char_limit !== req.charLimit ||
      length > char_limit ||
      !sliceFits(char_offset, end, total_length, has_more) ||
      has_more !== (next_offset !== null) ||
      (next_offset !== null && next_offset !== end)
    ) {
      throw inconsistent(req, data)
    }
    return {
      entryId: req.entryId,
      text: data.text,
      charOffset: char_offset,
      charLimit: char_limit,
      totalLength: total_length,
      hasMore: has_more,
      nextOffset: next_offset ?? total_length,
    }
  }

  if (req.charOffset > 0) {
    const { char_offset, total_length, has_more } = data
    if (char_offset === undefined || total_length === undefined || has_more === undefined) {
      throw incomplete(req, ENTRY_CONTENT_MODE.OFFSET_ONLY, missing(["char_offset", "total_length", "has_more"]))
    }
    // Offset-only mode returns everything from the offset: the slice runs to
    // the end, and nothing follows.
    const end = char_offset + codePointLength(data.text)
    if (
      char_offset !== req.charOffset ||
      has_more ||
      !sliceFits(char_offset, end, total_length, has_more) ||
      (char_offset <= total_length && end !== total_length)
    ) {
      throw inconsistent(req, data)
    }
    return {
      entryId: req.entryId,
      text: data.text,
      charOffset: char_offset,
      charLimit: 0,
      totalLength: total_length,
      hasMore: has_more,
      nextOffset: total_length,
    }
  }

  const total = codePointLength(data.text)
  return {
    entryId: req.entryId,
    text: data.text,
    charOffset: 0,
    charLimit: 0,
    totalLength: total,
    hasMore: false,
    nextOffset: total,
  }
}

/**
 * Does a slice [offset, end) agree with the document total and `has_more`?
 * Past the end of the document (offset > total) Python yields an empty slice
 * and nothing more; otherwise the slice ends inside the document and
 * `has_more` says whether text follows.
 */
function sliceFits(offset: number, end: number, total: number, hasMore: boolean): boolean {
  if (offset > total) return end === offset && !hasMore
  return end <= total && hasMore === end < total
}

function inconsistent(req: { entryId: EntryId }, data: DataclusterEntryContent): DataclusterMcpProtocolError {
  const { text, ...fields } = data
  return new DataclusterMcpProtocolError(
    `${DATACLUSTER_MCP_TOOL.GET_ENTRY_CONTENT} (entry ${req.entryId}) returned inconsistent pagination ` +
      `${JSON.stringify(fields)} for ${codePointLength(text)} characters of text`,
  )
}

function incomplete(
  req: { entryId: EntryId },
  mode: EntryContentMode,
  absent: ReadonlyArray<string>,
): DataclusterMcpProtocolError {
  return new DataclusterMcpProtocolError(
    `${DATACLUSTER_MCP_TOOL.GET_ENTRY_CONTENT} (${mode} mode, entry ${req.entryId}) omitted ${absent.join(", ")}`,
  )
}

/** What an ARK lookup established about the ARK's entries in the project's dataset. */
export type ArkLookup =
  | { status: typeof RAG_LOOKUP_STATUS.FOUND; entries: ArkEntry[] }
  | { status: typeof RAG_LOOKUP_STATUS.ENTRY_REINDEXING; reason: string }

/** One entry of an ARK, with the creation time that tells the live one from a stale one. */
export interface ArkEntry {
  entryId: EntryId
  /** Milliseconds since the epoch, from the entry's `metadata.created_at`. */
  createdAt: number
}

/** The cluster stamps `created_at` as an ISO 8601 datetime with an offset ("2026-11-04T16:44:28.162573+00:00"). */
const createdAtSchema = z.iso.datetime({ offset: true })

/**
 * Throw unless every hit belongs to `datasetId`, the project's own dataset.
 * The searches are scoped with `dataset_ids`, but the app does not trust that
 * scoping to hold: a result of another dataset — another project's, another
 * client's — must never reach the agent or `rag_get_text`, whatever the MCP
 * does with the filter.
 */
export function assertInDataset(
  hits: ReadonlyArray<{ entry_id: EntryId; dataset_id: DatasetId }>,
  datasetId: DatasetId,
  tool: DataclusterMcpTool | typeof ARK_LOOKUP_LABEL,
): void {
  const foreign = hits.find((h) => h.dataset_id !== datasetId)
  if (foreign !== undefined) {
    throw new DataclusterMcpProtocolError(
      `${tool} returned entry ${foreign.entry_id} of dataset ${foreign.dataset_id}, ` +
        `outside the project's dataset ${datasetId}`,
    )
  }
}

/**
 * What an ARK lookup proves about the ARK's entries in `datasetId`.
 *
 * The lookup is an exact `metadata_filters: {ark}` keyword search scoped to
 * the corpus project's dataset, so every hit must be of that dataset (tenancy,
 * assertInDataset), carry exactly this ARK, and carry a valid `created_at` —
 * anything else breaks the contract and is a protocol error, since trusting it
 * would read another document or guess the live entry.
 *
 * The other failure is not a contract violation but a moment: the cluster
 * counted matches the pages do not hold — `total` above the hits, matches it
 * could not address (`unaddressable`), or a page shifted by a write mid-walk
 * (the same entry twice). That is how a re-ingest looks while it replaces the
 * stale entry with the new one, and the live entry cannot be told from the
 * stale one, so the answer is ENTRY_REINDEXING — never a guess. Retrying
 * later succeeds. A missing `total` is a protocol error: nothing says whether
 * the set is complete.
 */
export function arkLookup(
  hits: ReadonlyArray<{
    entry_id: EntryId
    dataset_id: DatasetId
    metadata?: { ark?: unknown; created_at?: unknown }
  }>,
  page: { total: number | undefined; unaddressable: number | undefined },
  ark: string,
  datasetId: DatasetId,
): ArkLookup {
  assertInDataset(hits, datasetId, ARK_LOOKUP_LABEL)
  const entries = hits.map((h): ArkEntry => {
    if (h.metadata?.ark !== ark) {
      throw new DataclusterMcpProtocolError(
        `${ARK_LOOKUP_LABEL} for ${ark} returned an entry of ${JSON.stringify(h.metadata?.ark)}`,
      )
    }
    const createdAt = createdAtSchema.safeParse(h.metadata.created_at)
    if (!createdAt.success) {
      throw new DataclusterMcpProtocolError(
        `${ARK_LOOKUP_LABEL} for ${ark} returned entry ${h.entry_id} with no valid created_at ` +
          `(${JSON.stringify(h.metadata.created_at)}): the live entry cannot be told`,
        createdAt.error,
      )
    }
    return { entryId: h.entry_id, createdAt: Date.parse(createdAt.data) }
  })
  if (page.total === undefined) {
    throw new DataclusterMcpProtocolError(`${ARK_LOOKUP_LABEL} for ${ark} returned no pagination.total`)
  }
  const reindexing = (reason: string): ArkLookup => ({
    status: RAG_LOOKUP_STATUS.ENTRY_REINDEXING,
    reason: `${ARK_LOOKUP_LABEL} for ${ark}: ${reason}`,
  })
  if (page.unaddressable !== undefined && page.unaddressable > 0) {
    return reindexing(`${page.unaddressable} match(es) have no addressable entry id`)
  }
  if (page.total !== entries.length) {
    return reindexing(`the cluster counted ${page.total} entries but its pages held ${entries.length}`)
  }
  if (new Set(entries.map((e) => e.entryId)).size !== entries.length) {
    return reindexing("the same entry came back twice across pages")
  }
  return { status: RAG_LOOKUP_STATUS.FOUND, entries }
}

/**
 * The live entry among an ARK's entries: the most recently CREATED. A
 * re-ingest deletes the stale entry and then creates the new one (worker-v2
 * LiveClusterSink.upsert), so while a tombstone lags the newest entry is the
 * one the index serves (D13). The platform entry number is not an order — the
 * backend batch sync assigns ids by version — so it only breaks a tie between
 * equal creation times (the timestamp is read to the millisecond), keeping the
 * choice deterministic. `null` when the ARK has no entry.
 */
export function pickLiveEntryId(entries: readonly ArkEntry[]): EntryId | null {
  let live: ArkEntry | null = null
  for (const e of entries) {
    if (
      live === null ||
      e.createdAt > live.createdAt ||
      (e.createdAt === live.createdAt && entryOrdinal(e.entryId) > entryOrdinal(live.entryId))
    ) {
      live = e
    }
  }
  return live === null ? null : live.entryId
}

/**
 * An entry's chunks as page ranges, or [] when any of them lacks a folio or
 * offsets (the pre-worker-v2 pipeline): then the ranges cannot be the
 * authority and foliosForEntry falls back to the headings. Each chunk goes
 * through chunkToPassage, so an invalid folio or range is a protocol error.
 */
export function folioChunksOf(chunks: readonly DataclusterChunk[]): FolioChunk[] {
  const out: FolioChunk[] = []
  for (const chunk of chunks) {
    const passage = chunkToPassage(chunk)
    if (passage === null || passage.folio === null || passage.charRange === null) return []
    out.push({ folio: passage.folio, charStart: passage.charRange[0], charEnd: passage.charRange[1], text: passage.snippet })
  }
  return out
}

/**
 * An entry's processed text split per folio, the same in both runners: from
 * its chunks' offsets when they tile the text (worker-v2 entries), else from
 * its headings (older entries). Text with no heading at all is a protocol
 * error of the cluster; a heading map that cannot be trusted is a
 * FolioMapAmbiguousError, which the quote check reports as such.
 */
export function foliosForEntry(
  entryId: EntryId,
  ark: string,
  text: string,
  chunks: readonly FolioChunk[],
): DocumentFolios {
  const fromChunks = foliosFromChunks(text, chunks)
  if (fromChunks !== null) return fromChunks
  try {
    return splitEntryFolios(text)
  } catch (err) {
    if (err instanceof EntryFolioFormatError) {
      throw new DataclusterMcpProtocolError(
        `entry ${entryId} (${ark}) is not in the worker's folio format: ${err.message}`,
        err,
      )
    }
    throw err
  }
}
