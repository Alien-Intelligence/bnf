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
// This produces plausible ranked results for development and demo purposes
// without any network calls or ML inference.

import type { RagQueryRequest, RagQueryResponse, RagPassage } from "./rag"
import { RAG_FIXTURES } from "./rag-fixtures"
import type { RagFixture } from "./rag-fixtures"

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
    const k = req.k ?? 12

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
      title: x.p.title,
      year: x.p.year,
    }))

    return {
      passages,
      total: scored.length,
      modelVersion: "fake-rag-v1",
    }
  },
}
