# 01 — Product Overview

## Intent

A research environment for **librarians and scholars** at the Bibliothèque
nationale de France. It lets a domain expert build, ingest, and interrogate a
large thematic corpus drawn from the BnF's holdings — with an AI agent doing the
heavy lifting at each stage, but the human always in control and always able to
*understand the state of their corpus*.

The guiding UX principle (from client feedback): **the librarian must always
feel they understand their corpus** — its size, composition, gaps, and
provenance — not just chat with a black box. Hence the stats, facets, and
document inspection surfaces are first-class, not afterthoughts.

The product is **co-branded**: Alien Intelligence (the platform) × BnF (the
institution / data source). It runs inside a focused three-step workspace.

## The three steps

### Step 1 — Constituer (Corpus creation)

The user converses with a **corpus-building agent** (Claude + the BnF MCP). The
agent searches the BnF catalogue, proposes documents, and adds/removes them from
a working corpus. Every document is identified by a unique **ARK** id.

This is **multi-turn and multi-session**: corpus building is long and iterative.
The agent must know the *current* corpus state and what was done before — across
sessions — so the work compounds rather than restarts. This is backed by:

- **Sessions** — resumable conversations, each a thread of work on the corpus.
- **Project memory** — a persistent, curated set of facts the agent reads at the
  start of every session (scope, period, language constraints, source
  preferences, decisions taken). Global to the project, not per-session.

The right-hand panel gives **corpus comprehension**: summary tiles (count,
period, types, languages) always visible, then a collapsible **"Filtres et
statistiques" drawer** (collapsed by default so the document list is the focus;
expands with an animation) holding the facet distributions (type / language /
source) and the chronological histogram, plus a full-text filter and a document
detail panel (metadata + ARK + external BnF / IIIF links). Clicking a facet bar
or a histogram bin filters the list; active filters show as removable chips.

The chat / workspace split is **40% chat / 60% workspace** so the conversation
stays prominent without crowding the comprehension panel.

### Step 2 — Ingérer (Ingestion)

The user triggers ingestion. This is **mostly backend**: a job processes the
corpus — OCR/text extraction → semantic chunking → embedding → indexing into the
data cluster (the RAG store). From the UX side it is a progress view with an
explicit "**this continues server-side, come back later**" affordance, then a
completion state that hands off to research.

Critically, ingestion is **incremental**: it operates on the **delta** between
the current corpus version and the last-ingested version, so a user can keep
adding documents in Step 1 and re-ingest only what changed.

### Step 3 — Rechercher (Research)

The user converses with a **research agent** that does RAG over the ingested
corpus. It answers with **inline citations** keyed to ARK + folio (which open a
side panel linking to the BnF IIIF viewer / Gallica / IIIF manifest), and it
writes **Markdown research notes** ("artifacts").

Like Step 1, this is **multi-turn / multi-session with project memory**. The
artifacts accumulate into a body of work. Two views:

- **Atelier** — working mode: chat + the note being built, as tabs.
- **Carnet** — the compiled research journal: all notes stitched into one
  continuous, exportable document with a table of contents.

## Onboarding (for less technical users)

The client's users are not all power users, so each interactive step has a
**guided intro dialog** that auto-opens the first time the user lands on it:

- **Corpus intro** — explains the chat (left), the corpus comprehension panel
  (right), and that the next step is to click **"Ingérer le corpus."**
- **Research intro** — explains asking the agent, clicking citations to open the
  source on the BnF, and the notes / Carnet.

Each is dismissable ("J'ai compris" or click-outside) and shows once per step. A
small **?** button next to the corpus title and the "Espace de recherche" header
**reopens** the relevant guide at any time. In the prototype, "seen" state is
in-memory (resets on reload); the product should persist it **per user** (see
the mocked-vs-real table and doc 09).

## What is mocked in the prototype (and must become real)

| Area | Prototype (mock) | Product (real) |
|------|------------------|----------------|
| Corpus agent | Scripted replies + canned `bnf.search` results | Claude streaming + BnF MCP tool calls |
| Corpus state | In-memory JS arrays / distributions | Persisted, versioned corpus in DB |
| Documents | ~18 hand-written sample docs per project; counts faked into the thousands | Real BnF notices resolved by ARK via MCP |
| Ingestion | A 5-second animated progress bar | Real async job: fetch → OCR → chunk → embed → index |
| RAG queries | Scripted answers + fake passage counts | Real vector search over the cluster + Claude synthesis |
| Notes | Pre-written Markdown with `[[ark|label|vue]]` bibrefs | Agent-authored Markdown, persisted, versioned |
| Memory | Static sectioned facts in JS | Persisted, agent-updated, user-editable memory store |
| Sessions | Snapshot objects swapped in | Real conversation threads with stored history |
| Projects | Two hard-coded datasets (`p1` 1889 press, `p2` medieval manuscripts) swapped client-side | Arbitrary user projects, each its own corpus/sessions/notes/memory |
| Citations → BnF | URL templates (`gallica.bnf.fr/<ark>/f<n>...`) | Same templates, real ARKs (structure already correct) |
| Onboarding "seen" state | In-memory (intros re-show on reload) | Persist per user so each intro shows once, ever (re-openable via the ? button) |

## Prototype → product mapping (where to look)

The single-file prototype (`BnF Corpus Research.dc.html`) is a useful reference
for **data shapes and UX contracts**:

- `TYPES`, `SOURCES`, `PROJECTS_META` — facet vocabularies and per-project config
  (language mix, source mix, period bins). The product should make these
  **derived from real corpus data**, not hard-coded.
- `SEED` / `P2_SEED` — the **document record shape**: `{ ark, title, author,
  year, type, lang, source, pages, excerpt }`. This is the canonical document
  projection the UI needs.
- `BUILD_SCRIPT` / `P2_BUILD` — the **shape of an agent corpus turn**: a user
  ask → an MCP search (tool, query, result count) → a corpus mutation
  (add/remove with counts) → the agent's reasoning. Real turns have the same
  structure; the mutations and counts come from real tool calls.
- `R_SCRIPT` / `P2_R_SCRIPT` — the **shape of a research turn**: a question → a
  `rag.query` → an answer with `cites: [{label, ark, vue}]` → an optional new
  note. The note bodies show the **citation syntax** `[[ark|label|vue]]`.
- The memory dialog (`MEMORY_CORPUS`, `MEMORY_RESEARCH`) — the **memory record
  shape**: sectioned items `{ id, text, origin }`, user-removable.
- Citation side panel — the **external link contract**: IIIF image API, Gallica
  item page, IIIF manifest, all derived from `<ark>` + `<vue>` (folio).

## Non-goals for the first build

- Real-time collaboration / multi-user editing of the same corpus.
- A general document viewer (we link out to the BnF IIIF viewer instead).
- Fine-grained per-document access control beyond project membership.
