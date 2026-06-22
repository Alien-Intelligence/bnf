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
// (entry-level) and full-text retrieval. Since fixtures have no entry ids, a
// stable synthetic id is derived from each unique ARK (1-based, in first-seen
// order) and shared across all three operations.

import { RAG_DEFAULT_K } from "@/lib/constants"
import type {
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

/** Fixtures for one ARK, ordered by char offset — the fake "document body". */
function fixturesForArk(ark: string): RagFixture[] {
  return RAG_FIXTURES.filter((f) => f.ark === ark).sort(
    (a, b) => a.charRange[0] - b.charRange[0],
  )
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
      charRange: x.p.charRange,
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
    // Concatenate this ARK's fixture snippets into a single "document body".
    const body = ark
      ? fixturesForArk(ark)
          .map((f) => f.snippet)
          .join("\n\n")
      : ""

    const total = body.length
    const offset = Math.min(Math.max(req.charOffset ?? 0, 0), total)
    const limit = req.charLimit ?? 4000
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
}
