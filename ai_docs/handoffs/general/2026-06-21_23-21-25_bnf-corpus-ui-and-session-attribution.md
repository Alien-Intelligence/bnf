---
date: 2026-06-21T23:21:25+0200
researcher: Claude Code
git_commit: 0d44bc0e5cd480c0c9fbd9801f2a516afbbc0158
branch: feature/langfuse-tracing
repository: datastreaming-demos
topic: "BnF corpus UI parity, agent chat rewrite & per-session attribution"
tags: [implementation, bnf, corpus, agent-chat, filters, prisma, prompts, ui]
status: complete
last_updated: 2026-06-21
last_updated_by: Claude Code
type: implementation_strategy
---

# Handoff: general — BnF corpus UI parity, chat rewrite & per-session attribution

## Task(s)
A long single-session sweep on the **bnf** app (`datastreaming-demos/bnf`) driven by live design/UX review. All items below are **implemented + validated (tsc/lint/build/smoke green) but UNCOMMITTED**. None are mid-flight; the only open work is commit + browser QA.

1. **Design-parity fixes (status: done)** — project switcher in the workspace header; document detail panel rebuilt (metadata grid, OCR excerpt, ARK box, external links, "retirer"); filters/stats restructured into 3-column facet cards + chrono card + numérisation card; OCR/numérisation status surfaced.
2. **OCR / numérisation data layer (done)** — real data, not the prototype heuristic. `Document.ocrAvailable` (migration), extracted from MCP, `classifyIngestion()`, `CorpusSnapshot.numerisation`.
3. **Filter dimensions (done)** — added clickable **ingestion-class** filter (numérisation buckets) and later **session** filter (see #9).
4. **SPARQL + catalogue prompt knowledge (done, then reframed)** — `bnf-knowledge.ts` injects data.bnf.fr SPARQL guide + cb→Gallica resolution. Later reframed so the corpus agent does **NOT** gate/judge on "ingestability" or ARK "validity" (that is the Ingérer step's job).
5. **Agent chat panel rewrite (done)** — render `chat.turns` directly (dropped SDK `<ChatPanel>`): stick-to-bottom-only scroll, custom thinking box w/ live timer + spinner, uniform tool block (name + collapsible params + status pill), corpus mutation **+N/−N pill** with duplicates, and the **`ask_user`** interactive chooser tool (ends turn; only one active at a time; "Répondre librement" escape hatch).
6. **`corpus_add` dedup + agent guidance (done)** — server-side dedup reports `requested/added/duplicates`; agent told never to pre-filter; pagination-exhaustiveness + write-to-memory-as-you-go prompt directives.
7. **External BnF URL builders fixed (done)** — IIIF viewer `view3if/ga/<ark>`, Gallica `…/<ark>/f1.item` (bare `/<ark>` 403s!), OAI, manifest, catalogue record; fixed broken IIIF image API URL.
8. **Memory box + dialog (done)** — were built but unrendered; wired the compact box into the sessions rail + the (redesigned) dialog; live refresh.
9. **Client-side filters rewrite (done)** — filters/selection moved from URL-navigation (caused reload loops + lag) to React state, URL mirrored via shallow `history.replaceState`; `keepPreviousData`; corpus/memory panels reconcile on turn-end.
10. **Per-session attribution (done, via subagent)** — `CorpusContribution` join table, multi-session tagging, session facet + filter. Smoke Test 11 added.
11. **Misc (done)** — French-thinking directive in shared preamble; page-shaped document thumbnail; histogram flex-spread; `tsconfig` excludes `sandbox` (build was failing on `sandbox/bnf-ingest`).

## Critical References
- `design/docs/01-product-overview.md` and the prototype `design/BnF Corpus Research.dc.html` (UX contracts).
- `playbook/` (esp. `models.md`, `corpus-versioning.md`, `i18n.md`, `agent-streaming.md`).
- Memory: `bnf-corpus-add-resolve`, `bnf-numerisation-ingestability` (in the project memory dir) record the key decisions.

## Recent changes
Agent/prompts: `lib/agent/prompts/bnf-knowledge.ts` (new file — SPARQL + catalogue), `…/shared.ts` (French-thinking + ask_user), `…/corpus.ts` (tools list, pagination/memory sections, dropped the 25-doc sample), `…/builder.ts:100` (`loadCorpusSnapshot` now groupBy aggregates, no per-doc sample). Tools: `lib/agent/tools/interaction.ts` (new `ask_user`), `…/tools/corpus.ts` (dedup result + sessionId), `…/tools/constants.ts`, `…/tools/index.ts`.
Models/data: `prisma/schema.prisma` (+`ocrAvailable`, +`CorpusContribution`), `models/corpus/{schema,queries,service,types}.ts`, `models/documents/schema.ts` (`classifyIngestion`), `lib/mcp/normalize.ts`, `lib/documents/resolver.ts`, `lib/constants.ts` (URL builders).
Hooks/API: `hooks/api/corpus.ts` (keepPreviousData), `app/api/projects/[id]/corpus/route.ts` (ingest+session params).
UI: `components/layouts/corpus/chat.tsx` (full rewrite), `…/document-list.tsx`, `…/sessions-sidebar.tsx`, `components/cards/corpus/{filters-drawer,facet-bars,period-histogram,full-text-input,active-filters-bar,numerisation-card,document-row}.tsx`, `components/cards/tools/ask-user.tsx`, `components/badges/tools/{call,mutation-pill}.tsx`, `components/cards/memory/{box,section,item}.tsx`, `components/dialogs/memory/index.tsx`, `components/sheets/corpus/document-detail.tsx`, `components/badges/documents/thumb.tsx` (new), `components/layouts/workspace/{header,project-switcher}.tsx`.
`app/[locale]/projects/[projectId]/constituer/client.tsx` (client-side filters + turn-end reconcile). `messages/{fr,en}.json`, `scripts/smoke-test.ts` (+Test 11), `tsconfig.json`.

## Learnings
- **New Prisma model → must restart `next dev`.** `lib/db.ts:15-17` pins the client to `globalThis` (HMR survival), so a running dev server keeps a stale client and `prisma.corpusContribution` is `undefined` until restart. Code/build/smoke were all green; it was purely the cached singleton.
- **Filters as URL navigation = the root of the lag/loop.** `router.push` re-ran the page server component every filter click. The debounced full-text input then re-committed the same `?q=` each render (unstable `onCommit`) → infinite reload. Fixed by client-state filters + a value-equality guard in `full-text-input.tsx`.
- **`stream.domainEvents` (corpus/memory events) only fires on the live `onDomainEvent` channel and can be missed** → panels went stale until manual refresh. Fixed with a reliable **turn-end reconcile** in the constituer client (invalidate corpus+memory when `isStreaming` goes true→false).
- **Gallica bare `/<ark>` 403s** for some docs; `/<ark>/f1.item` is the stable deep-link. The `.r=…?rk=…` form carries a non-reconstructable search-rank cursor.
- **Prompt is cached per session** (`AppSession.systemPrompt`) → all prompt changes reach NEW sessions only, unless `PromptBuilder.invalidate(projectId, scope)` is called.
- **Corpus building is decoupled from ingestability** (product decision): the agent must not filter/warn/judge by it; `corpus_add` no longer surfaces `nonIngestable` to the agent.
- The **session facet** uses `prisma.corpusContribution.groupBy` scoped via the `document` relation filter; multi-session docs count once per contributing session.

## Artifacts
- This handoff: `ai_docs/handoffs/general/2026-06-21_23-21-25_bnf-corpus-ui-and-session-attribution.md`
- Migrations: `prisma/migrations/*_add_document_ocr_available/`, `prisma/migrations/*_add_corpus_contribution/`
- New files: `lib/agent/prompts/bnf-knowledge.ts`, `lib/agent/tools/interaction.ts`, `components/cards/tools/ask-user.tsx`, `components/badges/documents/thumb.tsx`, `components/cards/memory/box.tsx`, `components/layouts/workspace/project-switcher.tsx`.
- Project memories updated: `bnf-corpus-add-resolve.md`, `bnf-numerisation-ingestability.md` (in the user's project memory dir).

## Action Items & Next Steps
1. **Commit** — ~38 modified + ~6 new files + 2 migrations, all uncommitted. Was never committed per "don't commit unless asked". NOTE the branch is `feature/langfuse-tracing` (it changed from `feature/bnf-app` during the session) — confirm the intended branch before committing; consider logical chunks (UI parity / data layer / chat rewrite / filters / session attribution).
2. **Restart `next dev`** before testing (Prisma model — see Learnings).
3. **Browser QA (auth-gated; not driven this session):** chat streaming + scroll-up-while-streaming + thinking timer; `ask_user` (single active, escape hatch); filter clicks/search (instant, no reload, URL mirrors); memory box+dialog; session facet filter; document thumbnails; the doc detail external links.
4. Optionally invalidate cached `systemPrompt` so existing sessions pick up the prompt changes (French thinking, pagination/memory, no-ingestability, ask_user).
5. Optional: apply the same client-state filter pattern to the research **Atelier** if it ever gets facets.

## Other Notes
- **NOT my work (separate concurrent effort):** `bnf/docker-compose.yml`, `bnf/lib/cluster/{client,contracts}.ts`, `bnf/models/ingest/service.ts`, `bnf/components/cards/ingest/stage-pipeline.tsx` are modified by the ingest-worker effort (see memory `bnf-ingest-worker-self-contained`). Keep those changes; they're unrelated to this UI/agent handoff.
- The pre-existing **seed search bug** (`bnf-mcp-envelope-search-bug` memory) is untouched.
- All validation this session: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run smoke` (11/11) — green. There is also a crude i18n key-sweep one-liner used repeatedly; both `messages/*.json` resolve.
</content>
