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

import { DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import type { DataclusterChunk, DataclusterEntryContent } from "./datacluster-mcp-client"
import { EntryFolioFormatError, codePointLength, splitEntryFolios } from "./folio-text"
import type { DocumentFolios } from "./folio-text"
import type { RagEntryContent, RagPassage } from "./rag"

/**
 * Map a cluster chunk to a RagPassage. Returns null when the chunk carries no
 * ARK — it cannot serve as a citation source, so it is dropped (never cited
 * without an ARK; never an invented one). Folio is preserved when present and
 * left null otherwise. The char range is set only when the chunk carries BOTH
 * offsets (worker-v2 writes them together); a chunk indexed before offsets
 * existed reports `null`, not a `[0, 0]` that would read as "the start of the
 * document". An offset pair that is not a valid range is a protocol error.
 */
export function chunkToPassage(chunk: DataclusterChunk): RagPassage | null {
  const { ark, folio, char_start, char_end, entry_id } = chunk.metadata
  if (typeof ark !== "string" || ark.length === 0) return null

  return {
    ark,
    folio: typeof folio === "number" ? folio : null,
    snippet: chunk.chunk_text,
    score: chunk.score,
    charRange: toCharRange(ark, char_start, char_end),
    entryId: typeof entry_id === "number" ? entry_id : null,
  }
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
  req: { entryId: number; charOffset: number; charLimit: number },
): RagEntryContent {
  const missing = (fields: Array<keyof DataclusterEntryContent>) =>
    fields.filter((f) => data[f] === undefined)

  if (req.charLimit > 0) {
    const { char_offset, char_limit, total_length, has_more, next_offset } = data
    if (
      char_offset === undefined ||
      char_limit === undefined ||
      total_length === undefined ||
      has_more === undefined ||
      next_offset === undefined
    ) {
      throw incomplete(req, "paginated", missing(["char_offset", "char_limit", "total_length", "has_more", "next_offset"]))
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
      throw incomplete(req, "offset-only", missing(["char_offset", "total_length", "has_more"]))
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

function incomplete(
  req: { entryId: number },
  mode: string,
  absent: ReadonlyArray<string>,
): DataclusterMcpProtocolError {
  return new DataclusterMcpProtocolError(
    `datacluster_get_entry_content (${mode} mode, entry ${req.entryId}) omitted ${absent.join(", ")}`,
  )
}

/**
 * The entry ids an ARK lookup proves belong to `ark` in the dataset searched.
 *
 * The lookup is an exact `metadata_filters: {ark}` keyword search scoped to
 * the corpus project's dataset, so every hit must carry exactly this ARK and
 * a positive integer entry id — anything else means the filter was not
 * applied, and trusting it would read another document. `total` is the
 * cluster's own count of matches: when it exceeds the hits returned, the
 * lookup is incomplete (more live entries for one ARK than its limit) and the
 * newest entry cannot be known, so that is a protocol error too.
 */
export function liveEntryIds(
  hits: ReadonlyArray<{ entry_id: unknown; metadata?: { ark?: unknown } }>,
  total: number | undefined,
  ark: string,
): number[] {
  if (total === undefined) {
    throw new DataclusterMcpProtocolError(`ARK lookup for ${ark} returned no pagination.total`)
  }
  if (total > hits.length) {
    throw new DataclusterMcpProtocolError(
      `ARK lookup for ${ark} matched ${total} entries but returned ${hits.length}: the live entry cannot be told`,
    )
  }
  return hits.map((h) => {
    if (h.metadata?.ark !== ark) {
      throw new DataclusterMcpProtocolError(
        `ARK lookup for ${ark} returned an entry of ${JSON.stringify(h.metadata?.ark)}`,
      )
    }
    if (typeof h.entry_id !== "number" || !Number.isSafeInteger(h.entry_id) || h.entry_id <= 0) {
      throw new DataclusterMcpProtocolError(
        `ARK lookup for ${ark} returned an invalid entry id ${JSON.stringify(h.entry_id)}`,
      )
    }
    return h.entry_id
  })
}

/**
 * The live entry among an ARK's entry ids: the highest. A re-ingest deletes
 * the stale entry and then creates the new one (worker-v2
 * LiveClusterSink.upsert), so when a tombstone lags the newest id is the one
 * the index serves (D13). `null` when the ARK has no entry.
 */
export function pickLiveEntryId(ids: readonly number[]): number | null {
  return ids.length === 0 ? null : Math.max(...ids)
}

/**
 * An entry's processed text split per folio. Text that is not in the worker's
 * folio format is a protocol error of the cluster (the quote check makes that
 * ARK unverifiable), the same in both runners.
 */
export function splitEntryText(entryId: number, ark: string, text: string): DocumentFolios {
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
