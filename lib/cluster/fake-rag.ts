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
// Parity with the real data-cluster MCP: this fake also serves keyword search
// (entry-level), full-text retrieval and whole-document folio text. Since
// fixtures have no entry ids, a stable synthetic id is derived from each unique
// ARK (1-based, in first-seen order) and shared across all operations.
//
// Each ARK's fixtures are assembled ONCE into a document body in the exact
// format worker-v2 stores (`## Folio <n>\n\n<text>` blocks joined by `\n\n`,
// see lib/cluster/folio-text.ts), and every fixture's charRange is computed
// from that body — so `getEntryContent` slices, `getDocumentFolios` splits and
// `query` offsets all agree with each other, as they do on the real cluster.

import { RAG_DEFAULT_K, RAG_GET_TEXT_DEFAULT_CHAR_LIMIT } from "@/lib/constants"
import { splitEntryFolios } from "./folio-text"
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

function entryIdForArk(ark: string): number {
  return ARK_TO_ENTRY_ID.get(ark) ?? 0
}

// --- Fake document bodies, worker-v2 format --------------------------------

/** Mirror of worker-v2 assembleMarkdown's heading and separator. */
function folioHeading(folio: number): string {
  return `## Folio ${folio}\n\n`
}
const FOLIO_BLOCK_SEPARATOR = "\n\n"
/** Snippets of one folio are separate paragraphs of that page. */
const SNIPPET_SEPARATOR = "\n\n"

/** Fixtures for one ARK, by folio then by fixture order (sort is stable). */
function fixturesForArk(ark: string): RagFixture[] {
  return RAG_FIXTURES.filter((f) => f.ark === ark).sort((a, b) => {
    const fa = a.folio ?? Number.POSITIVE_INFINITY
    const fb = b.folio ?? Number.POSITIVE_INFINITY
    return fa - fb
  })
}

/**
 * Assemble one ARK's fixtures into a folio-headed body and record where each
 * snippet landed. A fixture with no folio (an image-only document) has no
 * page block in worker-v2 either; it gets no body and no range.
 */
function assembleEntryBody(ark: string): { body: string; ranges: Map<RagFixture, [number, number]> } {
  const ranges = new Map<RagFixture, [number, number]>()
  const blocks: string[] = []
  let offset = 0
  let currentFolio: number | null = null
  let block = ""

  const flush = () => {
    if (currentFolio === null) return
    blocks.push(block)
    offset += block.length + FOLIO_BLOCK_SEPARATOR.length
  }

  for (const f of fixturesForArk(ark)) {
    if (f.folio === null) continue
    if (f.folio !== currentFolio) {
      flush()
      currentFolio = f.folio
      block = folioHeading(f.folio)
    } else {
      block += SNIPPET_SEPARATOR
    }
    const start = offset + block.length
    block += f.snippet
    ranges.set(f, [start, start + f.snippet.length])
  }
  flush()

  return { body: blocks.join(FOLIO_BLOCK_SEPARATOR), ranges }
}

const ENTRY_BODIES = new Map(ARK_ORDER.map((ark) => [ark, assembleEntryBody(ark)]))

/** A fixture's charRange inside its ARK's body; null for folio-less fixtures. */
function charRangeOf(f: RagFixture): [number, number] | null {
  return ENTRY_BODIES.get(f.ark)?.ranges.get(f) ?? null
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
  if (filters.yearFrom !== undefined && p.year !== undefined && p.year < filters.yearFrom) return false
  if (filters.yearTo !== undefined && p.year !== undefined && p.year > filters.yearTo) return false
  // type / lang / source filters cannot be applied here — RagFixture does not
  // carry those fields.  They are checked server-side on the real cluster.
  return true
}

export const FakeRagRunner = {
  async query(req: RagQueryRequest): Promise<RagQueryResponse> {
    const k = req.k ?? RAG_DEFAULT_K

    const scored = RAG_FIXTURES
      .map((p) => ({
        p,
        s: scoreAgainstQuery(req.query, p.topics, p.snippet),
      }))
      .filter((x) => x.s > 0)
      .filter((x) => passesFilters(x.p, req.filters))
      .sort((a, b) => b.s - a.s)

    const passages: RagPassage[] = scored.slice(0, k).map((x) => ({
      ark: x.p.ark,
      folio: x.p.folio,
      snippet: x.p.snippet,
      score: x.s,
      charRange: charRangeOf(x.p),
      entryId: entryIdForArk(x.p.ark),
      title: x.p.title,
      year: x.p.year,
    }))

    return {
      passages,
      total: scored.length,
      modelVersion: "fake-rag-v1",
    }
  },

  async keywordSearch(req: RagKeywordRequest): Promise<RagKeywordResponse> {
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
        return {
          ark,
          entryId: entryIdForArk(ark),
          title: first?.title ?? null,
          date: first?.year != null ? String(first.year) : null,
          score: v.score,
          snippets: v.snippets,
        }
      })

    return { hits, total: hits.length }
  },

  async getEntryContent(
    req: RagEntryContentRequest,
  ): Promise<RagEntryContent> {
    const ark = ENTRY_ID_TO_ARK.get(req.entryId)
    const body = ark ? (ENTRY_BODIES.get(ark)?.body ?? "") : ""

    const total = body.length
    const offset = Math.min(Math.max(req.charOffset ?? 0, 0), total)
    const limit = req.charLimit ?? RAG_GET_TEXT_DEFAULT_CHAR_LIMIT
    const end = limit === 0 ? total : Math.min(offset + limit, total)
    const text = body.slice(offset, end)

    return {
      entryId: req.entryId,
      text,
      charOffset: offset,
      charLimit: limit,
      totalLength: total,
      hasMore: end < total,
      nextOffset: end,
    }
  },

  async getDocumentFolios(req: DocumentFoliosRequest): Promise<DocumentFoliosResult> {
    const entry = ENTRY_BODIES.get(req.ark)
    if (!entry || entry.body.length === 0) return { status: "entry_not_found" }
    return {
      status: "found",
      entryId: entryIdForArk(req.ark),
      folios: splitEntryFolios(entry.body),
    }
  },
}
