# 09 — Open Questions for the Building Agent

Decisions and unknowns this handoff intentionally **defers**. Most depend on
Alien's infrastructure (data cluster, BnF MCP) or on choices the implementing
team owns. Resolve these with the relevant owners before/while building.

## A. Data cluster (RAG store) — ⛔ owned by the cluster team

1. **Query API.** What is the exact interface to similarity-search a project's
   index (params, filters, metadata returned)? `rag.query` (doc 05) is a target
   contract; confirm the real one and adapt.
2. **Write API.** How do the custom ingest scripts upsert vectors + metadata, and
   delete (tombstone) by ARK? Batch sizes, throughput, transactional guarantees?
3. **Index granularity.** One index per project? Per corpus version? How is the
   "ingested version" pointer reflected on the cluster side so research targets
   the right data?
4. **Embedding model.** Which model is the cluster's index built with? It must be
   fixed and shared by ingest + query. What's the re-embed story on model change?
5. **Metadata schema on chunks.** Confirm every chunk can carry `{ ark, folio,
   title, year, type, … }` so citations and facet-filtered retrieval work.

## B. Ingestion scripts — ⛔ owned by the building/cluster team

6. **The "faster than normal" scripts.** Where do they live, how are they
   invoked (CLI, library, RPC, batch system), and what is their exact
   input/output + progress callback contract? (Doc 07 proposes one.)
7. **OCR/text source.** For each document, is full text available (Gallica ALTO)?
   When it isn't, is fallback OCR in scope, and whose OCR? This drives the
   EXTRACT stage and per-doc failure rates.
8. **Chunking strategy.** Token size, overlap, and whether chunking is
   page/folio-aware (it must preserve folio for citations).
9. **Resumability mechanism.** Checkpointing granularity (per doc? per chunk
   batch?) so a killed job resumes without recomputation.

## C. Job runner — 🔶 implementation choice

10. **Technology.** Queue + workers vs. a workflow engine vs. the cluster's batch
    system. Requirement (doc 07) is the contract, not the tech.
11. **Concurrency & quotas.** How many parallel ingests per project / globally?
    Serialize per project (recommended) — confirm.
12. **Progress transport.** Redis pub/sub vs. DB polling for the Step 2 UI.

## D. BnF MCP — ⛔ confirm with Alien

13. **Exact tool surface.** Names, parameters, filter vocabulary, transport,
    auth, rate limits. Docs 05/06 state what the app needs; map to reality.
14. **Type/lang/source vocabularies.** The authoritative code lists, to build the
    normalization maps (doc 06) that feed the facets.
15. **IIIF reliability.** Is the IIIF manifest always resolvable per ARK, or must
    we fall back to URL templates? Any non-Gallica IIIF endpoints (Arsenal,
    Archives départementales)?

## E. Agents & models — 🔶 choices to validate

16. **Model selection** per agent (corpus vs. research) and cost/latency budget.
17. **Memory write policy tuning.** How aggressively should the agent write
    memory, and what dedupe/merge logic should the Memory service apply?
18. **Destructive-op confirmation.** Should large `corpus.remove` operations
    require explicit user confirmation in the UI, or is narrate-and-report enough?
19. **note.create vs. note.update.** The heuristic for when the research agent
    appends to an existing note vs. spawns a new one.
20. **Corpus sampling for the UI.** The panel shows a *sample* of a
    thousands-strong corpus. What sampling/ordering is most useful to a librarian
    (recency of add? relevance? facet-stratified?)?

## F. Product / data lifecycle — 🔶

21. **Corpus version retention.** Keep all versions forever, or prune old
    un-ingested drafts?
22. **Note versioning & export.** Is the Markdown "Carnet" export enough, or do
    they need PDF / DOCX / a citation-manager format (e.g. for a bibliography)?
23. **Multi-user.** First build is single-owner per project (doc 01 non-goals).
    When does collaboration land, and does it change the session/memory model?
24. **Auth / SSO.** BnF identity provider integration scope.
25. **Onboarding "seen" state.** Where is per-user "has seen the intro for step X"
    stored (user profile? per project?) so each guided intro shows once ever but
    stays re-openable via the ? button? Should intros re-trigger when the product
    changes materially (versioned onboarding)?

## G. Things deliberately settled (do NOT reopen without reason)

For clarity, these are **fixed** by the prototype/UX and should be implemented as
specified rather than re-litigated:

- ✅ ARK is the document identity and citation key.
- ✅ Citation syntax in notes is `[[ark|label|folio]]`; folio deep-links to IIIF.
- ✅ Project **memory is durable and curated**, separate from session/chat
   context; it is re-read each session and does not "fill up".
- ✅ The corpus is **versioned**; ingestion is a **delta** operation.
- ✅ Ingestion is **asynchronous** ("come back later") with a 4-stage progress
   model (extract → chunk → embed → index).
- ✅ Step 1 must always give the librarian **corpus comprehension** (stats,
   facets, period histogram, filtering, document inspection) — not just chat.
   Filters/stats live in a **collapsible drawer** (collapsed by default); chat is
   **40%** of the width, workspace **60%**.
- ✅ Each interactive step has a **guided onboarding intro** (auto-shows once,
   re-openable via a ? button).
- ✅ Atelier vs. Carnet are two **views** over the same notes, not two data models.

## Suggested build order 🔶

1. Data model + Corpus service (CRUD, versioning, diff, facets) — unblocks the UI.
2. BnF MCP client + `bnf.search`/`bnf.resolve` — real documents flow in.
3. Corpus agent loop (Step 1) with streaming + memory.
4. Job runner + ingestion contract (stub the cluster scripts behind the
   contract first; wire real scripts when ready).
5. RAG `rag.query` + research agent (Step 3) + notes.
6. Memory service hardening (merge/dedupe), Carnet export, polish.
