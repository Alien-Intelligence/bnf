# 02 — Architecture

> Status legend: ✅ defined · 🔶 proposed default · ⛔ deferred to building team.

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Web app (this prototype)                       │
│   Step 1 Constituer   │   Step 2 Ingérer   │   Step 3 Rechercher        │
└───────────┬───────────────────┬───────────────────────┬────────────────┘
            │ App API (REST/RPC + SSE streaming)                          
            ▼                   ▼                       ▼                  
┌──────────────────────────────────────────────────────────────────────┐
│                            App backend                                  │
│                                                                        │
│  ┌────────────────┐   ┌──────────────────┐   ┌──────────────────────┐ │
│  │ Agent service  │   │ Corpus service   │   │ Notes / Memory svc   │ │
│  │ (Claude loop)  │   │ (CRUD+versioning)│   │ (artifacts, facts)   │ │
│  └───────┬────────┘   └────────┬─────────┘   └──────────┬───────────┘ │
│          │                     │                         │             │
│          │  tool calls         │ submit/poll jobs        │             │
│          ▼                     ▼                         ▼             │
│  ┌────────────────┐   ┌──────────────────┐   ┌──────────────────────┐ │
│  │ MCP client     │   │ Job runner /     │   │ App DB (Postgres)    │ │
│  │ → BnF MCP      │   │ queue + workers  │   │ projects, corpus,    │ │
│  │   (by Alien)   │   │ (ingest jobs)    │   │ sessions, msgs,      │ │
│  └───────┬────────┘   └────────┬─────────┘   │ memory, notes, jobs  │ │
│          │                     │             └──────────────────────┘ │
└──────────┼─────────────────────┼──────────────────────────────────────┘
           │                     │
           ▼                     ▼
   ┌───────────────┐   ┌──────────────────────────────────────────────┐
   │ BnF catalogue │   │  Data cluster (RAG store) — ALREADY PROVISIONED │
   │ Gallica/IIIF  │   │  vector index per project, custom fast ingest  │ ⛔
   │ (via MCP)     │   │  scripts run as jobs                            │
   └───────────────┘   └──────────────────────────────────────────────┘
```

## Components

### Agent service ✅
Runs the two agent loops (corpus + research). Responsibilities:
- Maintain a streaming Claude conversation per session.
- Expose the agent's **tools** (doc 05) and execute them against the Corpus,
  Notes/Memory services, the RAG store, and the BnF MCP.
- Load **project memory** into the system prompt at session start; let the agent
  propose memory updates.
- Persist every turn (messages, tool calls, results) for session resume.

Recommended: an agent loop with tool-use (function calling). Streaming to the
client over SSE/WebSocket. See doc 04 for the loops, doc 08 for prompts.

### Corpus service ✅
Owns the corpus as a **versioned set of documents** (doc 03, doc 07):
- Add/remove documents (by ARK); resolve ARK metadata via the MCP.
- Compute corpus **stats and facets** (type / language / source / period) that
  drive the comprehension panel — derived from real data, not hard-coded.
- Snapshot the corpus into immutable **versions**; compute **deltas** between
  versions for incremental ingest.
- Submit ingest jobs to the Job runner and track corpus↔version↔ingest state.

### Notes / Memory service ✅
- **Notes (artifacts):** CRUD for Markdown research notes, with the inline
  citation syntax. Versioned 🔶 (notes get rewritten by the agent). Compiled
  "Carnet" export to Markdown.
- **Memory:** per-project, sectioned, persistent facts. Read at session start;
  written by the agent (proposed updates) and edited/removed by the user.

### Job runner / queue + workers ✅ (requirement) / ⛔ (internals)
**The backend MUST be able to run asynchronous, long-running jobs.** This is a
hard client requirement. Ingestion is the primary job type; it runs the
**custom fast chunk/embed scripts** (faster than the standard pipelines) and
writes into the data cluster. See doc 07. The orchestration (queue, workers,
retries, progress reporting) is in scope here; the *cluster-side ingest script
internals* are ⛔ deferred to the building team that owns the cluster.

### MCP client → BnF MCP ✅ / ⛔
The agent service is an MCP client to the **BnF MCP provided by Alien** (doc 06).
Used in Step 1 for catalogue search and ARK resolution. The MCP's exact tool
list and transport are ⛔ confirmed with Alien.

### Data cluster (RAG store) ⛔ already provisioned
"We have the data clusters ready." Treat it as an existing service that:
- accepts vectorized chunks (the custom ingest job writes to it), and
- answers similarity queries scoped to a project's index (the `rag.query` tool).

Its provisioning, sharding, and write path are owned by the building team.

## Models 🔶

| Role | Suggested | Notes |
|------|-----------|-------|
| Corpus agent | Claude (Sonnet-class) | Tool-use heavy, long multi-turn; needs strong instruction-following |
| Research agent | Claude (Sonnet-class, optionally a larger model for synthesis) | RAG synthesis + citation discipline + Markdown authoring |
| Embeddings | A single embedding model, fixed per cluster | Must match whatever the data cluster's index was built with — ⛔ confirm with the cluster team. **Do not** mix embedding models within one index. |
| OCR / text extraction | Use BnF/Gallica OCR (ALTO) where available; fallback OCR only if needed | ⛔ availability varies by document |

The embedding model choice is **coupled to the cluster** and is not a free
parameter — align it with the existing index. Re-embedding on model change is a
full re-ingest (doc 07).

## Datastores

| Store | Holds | Status |
|-------|-------|--------|
| App DB (Postgres 🔶) | projects, documents (metadata projection), corpus versions + membership, sessions, messages, tool-call log, memory, notes, jobs | ✅ schema in doc 03 |
| Vector index (data cluster) | embedded chunks per project, with ARK + folio metadata for citation | ⛔ provisioned |
| Object storage 🔶 | cached OCR/ALTO text, optional thumbnail cache | 🔶 |
| Cache 🔶 (Redis) | MCP search results, session working state, job progress pub/sub | 🔶 |

## Cross-cutting

- **Streaming:** agent turns stream token-by-token and surface tool calls as
  they happen (the prototype shows `bnf.search` / `rag.query` tool chips). Use
  SSE or WebSocket.
- **Idempotency:** corpus mutations and job submissions must be idempotent
  (agents retry). Key on `(corpus_version, operation)` / job dedupe keys.
- **Auth:** project-scoped; BnF SSO 🔶. Out of scope for first build detail.
- **Observability:** log every tool call with inputs/outputs; job stage timings.
