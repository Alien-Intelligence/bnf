# BnF Corpus Research — Build Handoff

This folder is the design-intent and engineering handoff for turning the
prototype (`../BnF Corpus Research.dc.html`) into a working application.

The prototype is a **deterministic, scripted demo** — no real model calls, no
backend. It exists to communicate the *intended* product, UX, and data shapes.
These documents describe what it takes to make it real.

## Audience

The **building agent / engineering team** that will implement the backend,
wire the agents, and connect to Alien's infrastructure (data clusters, BnF MCP).

## Reading order

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | [Product overview](01-product-overview.md) | Intent, the three steps, what's mocked vs. real, prototype → product mapping |
| 02 | [Architecture](02-architecture.md) | Services, models, databases, the job runner, the data cluster |
| 03 | [Data model](03-data-model.md) | Entities and schema: projects, documents, corpus versions, sessions, memory, notes, jobs |
| 04 | [Agent flows](04-agent-flows.md) | The corpus-building and research agent loops; multi-session + persistent memory mechanics |
| 05 | [App API & agent tools](05-app-api-and-agent-tools.md) | The tools agents call against the app, with schemas; the REST/RPC surface |
| 06 | [BnF MCP](06-bnf-mcp.md) | Integrating the BnF MCP provided by Alien; ARK and IIIF handling |
| 07 | [Ingestion jobs & corpus delta](07-ingestion-jobs-and-corpus-delta.md) | The custom fast chunk/embed pipeline as async jobs; corpus versioning & incremental ingest |
| 08 | [Prompting](08-prompting.md) | System prompts for the corpus agent and the research agent |
| 09 | [Open questions](09-open-questions-for-builder.md) | Deferred unknowns — decisions the building agent owns |

## The three steps (one sentence each)

1. **Constituer** — A Claude agent + the BnF MCP build a corpus of ARK-identified
   documents over many turns and sessions, with persistent project memory.
2. **Ingérer** — A backend **job** runs custom fast chunk/embed scripts and
   indexes the corpus delta into Alien's data cluster (the RAG store).
3. **Rechercher** — A RAG-backed Claude agent answers questions over the
   ingested corpus, cites sources by ARK + folio (IIIF), and writes Markdown
   research notes that persist across sessions.

## Hard requirements called out by the client

These are not optional and are detailed in docs 02 and 07:

- **The backend MUST run asynchronous jobs.** Ingestion is long-running
  (the UX explicitly says "continues server-side, come back later").
- **Custom ingestion scripts** (chunk + embed) that are *faster than the
  standard pipelines* run as those jobs. The data clusters themselves are
  **already provisioned** — their internals are owned by the building team.
- **The corpus is versioned, and ingestion is a delta operation.** We must be
  able to diff corpus state before/after so documents can be added iteratively
  without re-embedding the whole corpus.

## Status legend used throughout

- ✅ **Defined** — shape is fixed by the prototype/UX; implement as described.
- 🔶 **Proposed** — a reasonable default; the builder may revise.
- ⛔ **Deferred** — owned by the building team / depends on cluster internals.
