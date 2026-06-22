# Plan: Datacluster MCP — real RAG for the research path (Step 3)

**Date:** 2026-06-21
**Branch:** feature/langfuse-tracing (current) — confirm before commit
**Goal:** Make `ClusterRagClient.query` real mode answer the research agent's
`rag_query` tool by querying the **datacluster MCP** over the project's
ingested corpus, returning ARK+folio passages for citation.

## Why
`lib/cluster/rag.ts` real mode currently `throw`s "not yet implemented". The
research agent (Step 3) therefore only works against `FakeRagRunner` fixtures.
Wiring the datacluster MCP makes real research over the ingested corpus work.

## Verified contract (probed live, token = CLUSTER_BEARER_TOKEN)
- **Server:** `https://mcp-test-bnf-corpus-1781899491112.mcp.alpha.alien.club/mcp`
  — `mcp-datacluster` v0.1.24, mcp-base. Stateful Streamable-HTTP / JSON-RPC 2.0,
  `initialize` → `mcp-session-id` header (same handshake as the BnF MCP).
- **Auth:** opaque Bearer (`oat_…`) in `Authorization: Bearer`. 401 without it.
- **Tool:** `datacluster_vector_search_chunks`
  - args: `{ query, limit(1–100,def10), offset, score_threshold(0–1)?, dataset_ids:int[]?, entry_ids:int[]? }`
  - returns (inside JSON-RPC `result.content[0].text`):
    `{ success, data: { results: [{ id, score:float, chunk_text, metadata }], total, query_info } }`
  - **metadata carries:** `ark`, `folio` (number), `char_start`, `char_end`,
    `entry_id`, `dataset_id`, `chunk_index`, `docType`/`doc_type`.
    → maps cleanly to `RagPassage{ ark, folio, snippet, score, charRange }`.
- **Dataset mapping:** one dataset per project, slug `bnf-<projectId>`, with a
  numeric `id`. Discoverable via `datacluster_list_datasets`. The app stores **no**
  datasetId today → resolve slug→id lazily at query time (cache per process).

## Decisions (defaults chosen; confirm)
1. **Mode flag:** dedicated `DATACLUSTER_RAG_MODE` (fake|real, def fake) so real
   RAG is independent of ingest's shared `CLUSTER_MODE`. (Reusing `CLUSTER_MODE`
   would couple RAG-real to ingest-real, which is the separate worker effort.)
2. **Dataset id:** lazy slug resolution (no migration, no worker change).

## Files
- `lib/env.ts` — add lazy `requireClusterEnv()` → `{ DATACLUSTER_MCP_URL, CLUSTER_BEARER_TOKEN }`,
  same throw-on-missing pattern as `requireMcpEnv` (NO defaults).
- `lib/constants.ts` — datacluster MCP tuning (reuse MCP protocol/client consts;
  timeout/retry mirroring `BNF_MCP_*`; dataset-resolution cache TTL).
- **NEW** `lib/cluster/datacluster-mcp-client.ts` — focused JSON-RPC client:
  reuse `openMcpSession` (generic), `withTimeout`, `withRetry` from `lib/mcp/`;
  methods `listDatasetIdForProject(projectId)` (slug `bnf-<id>`, cached) and
  `vectorSearchChunks(args)`; unwrap success envelope (`success:false` → error);
  handle both `application/json` and `text/event-stream` like `BnfMcpClient`.
- **NEW** `lib/cluster/real-rag.ts` — `RealRagRunner.query(req)`: resolve dataset,
  call `vectorSearchChunks`, map `results[]` → `RagPassage[]`, return
  `{ passages, total, modelVersion: "datacluster-mcp" }`.
- `lib/cluster/rag.ts` — real branch → `RealRagRunner` (gated on the chosen flag).
- `.env.example` — document `DATACLUSTER_MCP_URL`, `CLUSTER_BEARER_TOKEN`, flag.

## Known limitations (documented, not silently dropped)
- Vector search supports only `dataset_ids` / `entry_ids` / `score_threshold` —
  app filters `type`/`lang`/`source`/`year` cannot be pushed down (same as fake
  mode). Year could be post-filtered later; out of scope here.
- `title`/`year` absent from chunk metadata → `RagPassage.title/year` left
  undefined; the UI joins title from the app's `Document` table by ARK.

## Update — THREE tools, not one (design override, confirmed by user)

Design doc 05 specified a single `rag_query`. The user overrode that ("design
might have said one but it didn't know enough"): the research agent now has
**three** datacluster capabilities, all app tools with server-side dataset
scoping (NOT the MCP attached wholesale — that would force the agent to supply
`dataset_ids` and risk cross-project leakage):

| Agent tool | datacluster MCP tool | Purpose |
|---|---|---|
| `rag_query` | `vector_search_chunks` | semantic; ARK+folio+charRange+`entryId` |
| `rag_keyword_search` | `keyword_search` | typo-tolerant; **filters** (type/lang/source → `metadata_filters`) |
| `rag_get_text` | `get_entry_content` | selective full text by `entryId` + char range |

- `RagPassage.entryId` added so the agent can chain search → full text.
- Filters live on **keyword** search (verified schema fields: `docType`/`lang`/`source`).
- `fake-rag.ts` gained parity impls (stable synthetic entryId per ARK).

## Validation
- `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Live smoke: a script that runs `RealRagRunner.query` against project
  `5a84093f-c78b-4413-acdb-a87198bdd09d` (dataset 14, 23 entries) and asserts
  ≥1 passage with a numeric folio + ARK.
- Browser QA (auth-gated): Rechercher step → ask a question → citations resolve
  to ARK+folio IIIF deep-links.
