import "server-only"
// lib/cluster/fake-rag.ts
// In-process RAG implementation for CLUSTER_MODE=fake.
//
// Scoring is purely lexical — no embedding model needed:
//   - Each topic keyword that appears in the query adds +0.30 to the raw score.
//   - Each query word (length > 3) found in the snippet adds +0.10.
//   - Raw score is clamped to [0, 1].
//
// Passages with a raw score of 0 are excluded from results (nothing matched).
// Remaining passages are sorted descending by score, then sliced to k.
//
// Parity with the real data-cluster MCP — what the fake writes and returns
// goes through the same code as the real path:
//   - each ARK's fixtures (one whole page each) are written ONCE into a body in
//     the worker's exact format by `assembleEntryText` (folio-text.ts), which
//     also yields each page's code-point `char_start` / `char_end`;
//   - passages are shaped by `chunkToPassage` from chunks built like the
//     worker's (trimmed page text, ark / folio / offsets / entry_id metadata);
//   - entry slices are cut like mcp-datacluster's get_entry_content (by code
//     point, per mode) and mapped by `toEntryContent`;
//   - the ARK lookup goes through `pickLiveEntryId`, the split through
//     `splitEntryFolios`;
//   - an unknown entry id is a DataclusterMcpNotFoundError, as on the wire.
// Since fixtures have no entry ids, a stable synthetic id is derived from each
// unique ARK (1-based, in first-seen order) and shared across all operations.

import {
  FAKE_RAG_MODEL_VERSION,
  RAG_DEFAULT_K,
} from "@/lib/constants"
import { DataclusterMcpNotFoundError } from "./datacluster-mcp-client"
import type { DataclusterChunk, DataclusterEntryContent } from "./datacluster-mcp-client"
import { assembleEntryText, codePointLength, sliceCodePoints, splitEntryFolios } from "./folio-text"
import { chunkToPassage, pickLiveEntryId, toEntryContent } from "./rag-wire"
import type {
  DocumentFoliosRequest,
  DocumentFoliosResult,
  RagEntryContent,
  RagEntryContentRequest,
  RagKeywordHit,
  RagKeywordRequest,
  RagKeywordResponse,
  RagPassage,
  RagQueryRequest,
  RagQueryResponse,
} from "./rag"
import { RAG_FIXTURES } from "./rag-fixtures"
import type { RagFixture } from "./rag-fixtures"

// --- Stable synthetic entry ids (ARK ↔ id), in first-seen fixture order. -----
const ARK_ORDER: string[] = [...new Set(RAG_FIXTURES.map((f) => f.ark))]
const ARK_TO_ENTRY_ID = new Map(ARK_ORDER.map((ark, i) => [ark, i + 1]))
const ENTRY_ID_TO_ARK = new Map(ARK_ORDER.map((ark, i) => [i + 1, ark]))

/** The synthetic entry id of a fixture ARK. Every caller holds a fixture's ARK. */
function entryIdForArk(ark: string): number {
  const id = ARK_TO_ENTRY_ID.get(ark)
  if (id === undefined) throw new Error(`fake cluster: ${ark} is not a fixture ARK`)
  return id
}

// --- Fake document bodies, worker-v2 format --------------------------------

/** Fixtures for one ARK, in folio order (the worker writes pages by `ordre`). */
function fixturesForArk(ark: string): RagFixture[] {
  return RAG_FIXTURES.filter((f) => f.ark === ark).sort((a, b) => a.folio - b.folio)
}

type EntryBody = { text: string; ranges: Map<RagFixture, [number, number]> }

function assembleEntryBody(ark: string): EntryBody {
  const pages = fixturesForArk(ark)
  const { text, ranges } = assembleEntryText(pages.map((f) => ({ folio: f.folio, text: f.snippet })))
  return { text, ranges: new Map(pages.map((f, i) => [f, ranges[i]])) }
}

const ENTRY_BODIES = new Map(ARK_ORDER.map((ark) => [ark, assembleEntryBody(ark)]))

function bodyOf(ark: string): EntryBody {
  const body = ENTRY_BODIES.get(ark)
  if (body === undefined) throw new Error(`fake cluster: no body for ${ark}`)
  return body
}

/** The chunk the worker would have indexed for this fixture's page. */
function chunkOf(f: RagFixture, score: number): DataclusterChunk {
  const range = bodyOf(f.ark).ranges.get(f)
  if (range === undefined) throw new Error(`fake cluster: no range for ${f.ark} f${f.folio}`)
  const entryId = entryIdForArk(f.ark)
  return {
    id: `fake-${entryId}-${f.folio}`,
    score,
    chunk_text: f.snippet.trim(),
    metadata: { ark: f.ark, folio: f.folio, char_start: range[0], char_end: range[1], entry_id: entryId },
  }
}

/**
 * What mcp-datacluster's get_entry_content returns for this text and request,
 * mode by mode (MCPs/mcp-datacluster/src/tools/get_entry_content.py), with
 * Python's code-point slicing.
 */
function entryContentPayload(
  text: string,
  entryId: number,
  charOffset: number,
  charLimit: number,
): DataclusterEntryContent {
  const total = codePointLength(text)
  if (charLimit > 0) {
    const slice = sliceCodePoints(text, charOffset, charOffset + charLimit)
    const end = charOffset + codePointLength(slice)
    return {
      entry_id: entryId,
      text: slice,
      char_offset: charOffset,
      char_limit: charLimit,
      total_length: total,
      has_more: end < total,
      next_offset: end < total ? end : null,
    }
  }
  if (charOffset > 0) {
    return { text: sliceCodePoints(text, charOffset), char_offset: charOffset, total_length: total, has_more: false }
  }
  return { text }
}

function scoreAgainstQuery(
  query: string,
  topics: string[],
  snippet: string,
): number {
  const q = query.toLowerCase()
  let score = 0

  // Topic match: +0.30 per topic keyword present in the query string.
  for (const t of topics) {
    if (q.includes(t.toLowerCase())) {
      score += 0.3
    }
  }

  // Snippet word match: +0.10 per query word (length > 3) found in snippet.
  const snippetLower = snippet.toLowerCase()
  const qWords = q.split(/\s+/).filter((w) => w.length > 3)
  for (const w of qWords) {
    if (snippetLower.includes(w)) {
      score += 0.1
    }
  }

  return Math.min(1, score)
}

function passesFilters(
  p: RagFixture,
  filters?: RagQueryRequest["filters"],
): boolean {
  if (!filters) return true
  if (filters.yearFrom !== undefined && p.year < filters.yearFrom) return false
  if (filters.yearTo !== undefined && p.year > filters.yearTo) return false
  // type / lang / source filters cannot be applied here — RagFixture does not
  // carry those fields.  They are checked server-side on the real cluster.
  return true
}

export const FakeRagRunner = {
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    req.signal.throwIfAborted()
    const k = req.k ?? RAG_DEFAULT_K

    const scored = RAG_FIXTURES
      .map((p) => ({
        p,
        s: scoreAgainstQuery(req.query, p.topics, p.snippet),
      }))
      .filter((x) => x.s > 0)
      .filter((x) => passesFilters(x.p, req.filters))
      .sort((a, b) => b.s - a.s)

    const passages = scored
      .slice(0, k)
      .map((x) => chunkToPassage(chunkOf(x.p, x.s)))
      .filter((p): p is RagPassage => p !== null)

    return {
      passages,
      total: scored.length,
      modelVersion: FAKE_RAG_MODEL_VERSION,
    }
  },

  async keywordSearch(req: RagKeywordRequest): Promise<RagKeywordResponse> {
    req.signal.throwIfAborted()
    const limit = req.limit ?? 20

    // Score per fixture, then collapse to the best-scoring chunk per ARK so the
    // result is entry-level (mirrors the real keyword search granularity).
    const bestByArk = new Map<string, { score: number; snippets: string[] }>()
    for (const f of RAG_FIXTURES) {
      const s = scoreAgainstQuery(req.query, f.topics, f.snippet)
      if (s <= 0) continue
      const cur = bestByArk.get(f.ark)
      if (!cur) {
        bestByArk.set(f.ark, { score: s, snippets: [f.snippet] })
      } else {
        cur.score = Math.max(cur.score, s)
        if (cur.snippets.length < 3) cur.snippets.push(f.snippet)
      }
    }

    const hits: RagKeywordHit[] = [...bestByArk.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([ark, v]) => {
        const first = fixturesForArk(ark)[0]
        if (first === undefined) throw new Error(`fake cluster: no fixture for ${ark}`)
        return {
          ark,
          entryId: entryIdForArk(ark),
          title: first.title,
          date: String(first.year),
          score: v.score,
          snippets: v.snippets,
        }
      })

    return { hits, total: hits.length }
  },

  async getEntryContent(req: RagEntryContentRequest): Promise<RagEntryContent> {
    req.signal.throwIfAborted()
    const ark = ENTRY_ID_TO_ARK.get(req.entryId)
    if (ark === undefined) {
      throw new DataclusterMcpNotFoundError(`fake cluster: no entry ${req.entryId}`)
    }
    const payload = entryContentPayload(bodyOf(ark).text, req.entryId, req.charOffset, req.charLimit)
    return toEntryContent(payload, req)
  },

  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    req.signal.throwIfAborted()
    const hits = ARK_TO_ENTRY_ID.has(req.ark)
      ? [{ entry_id: entryIdForArk(req.ark), metadata: { ark: req.ark } }]
      : []
    const entryId = pickLiveEntryId(hits, req.ark)
    if (entryId === null) return { status: "entry_not_found" }
    return { status: "found", entryId, folios: splitEntryFolios(bodyOf(req.ark).text) }
  },
}
