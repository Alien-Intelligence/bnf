# 06 — BnF MCP Integration

The corpus-building agent (Step 1) discovers and resolves documents through the
**BnF MCP server provided by Alien**. The app's agent service is an **MCP
client**; it surfaces a curated subset of MCP capabilities to Claude as the
`bnf.*` tools (doc 05).

> Much of the MCP's concrete surface is ⛔ **owned by Alien** — confirm the exact
> tool names, parameters, transport, and auth with them. This doc states what
> the app *needs* from the MCP and how it adapts the results.

## What the app needs from the MCP

| Capability | Used by | App tool | Notes |
|-----------|---------|----------|-------|
| Catalogue search (full-text + filters) | corpus agent | `bnf.search` | returns ARKs + brief metadata; must support date range, type, language filters and report a total hit count |
| ARK resolution (full metadata + IIIF manifest) | corpus agent, corpus service | `bnf.resolve` | resolves one/many ARKs to the `document` projection (doc 03) |
| (optional) Holdings / availability of digitized full text | ingest planning | — | helps predict OCR availability per doc 🔶 |

If the MCP exposes richer tools (e.g. similar-item, subject browse), expose them
to the agent too 🔶 — but the two above are the minimum for the flows.

## Adapting MCP results → app shapes

The MCP's native response shape will not be exactly the app's `document` shape.
The Corpus service normalizes:

```
MCP hit  ──►  document {
                ark, title, author, year, doc_type, lang, source,
                pages, excerpt?, iiif_manifest_url?, raw_metadata = <full MCP payload>
              }
```

- **`doc_type`** — map the MCP/Dublin-Core type to the app's facet vocabulary
  (`press|image|estampe|book|map|manuscript|enlum|charte|…`). Keep a mapping
  table; default unknowns to a generic bucket 🔶.
- **`lang`** — normalize MARC/ISO codes (`fre→fr`, `eng→en`, `lat→la`).
- **`source`** — Gallica / RetroNews / Data BnF / Arsenal / Archives dép., per
  where the digitization lives.
- **`year`** — parse from the notice date; keep a single representative year
  (the UI bins into periods/centuries). Preserve the raw date in `raw_metadata`.
- **`raw_metadata`** — always store the untouched MCP payload for traceability.

## ARK is the identity ✅

Everything keys on the **ARK** (`ark:/12148/…`). It is stable, the natural key
for `document`, the membership key for corpus versions, and the citation key in
notes. Never invent or mutate ARKs; treat them as opaque strings.

## IIIF / external links ✅

The citation side panel and the document detail panel link out to the BnF using
**templates derived from the ARK** (+ folio/`vue` for citations). These are
already correct in the prototype:

```
IIIF image (a page):  https://gallica.bnf.fr/<ark>/f<folio>/full/full/0/native.jpg
Gallica item page:    https://gallica.bnf.fr/<ark>/f<folio>.item
IIIF manifest:        https://gallica.bnf.fr/iiif/<ark>/manifest.json
```

Prefer the **IIIF manifest** resolved via `bnf.resolve` when present (more
reliable than constructing URLs); fall back to the templates. The IIIF viewer
deep-link is what makes "click a citation → see the exact folio on the BnF" work
— so the **folio must be carried from retrieval (`rag.query`) through the
citation** (doc 04, doc 05).

## Operational concerns 🔶

- **Caching** — cache `bnf.search` results and `bnf.resolve` metadata (Redis
  /object store). Catalogue search over thousands of hits is the hot path in
  Step 1.
- **Rate limits / backoff** — the MCP fronts BnF services; respect limits, retry
  with backoff, and surface partial results rather than failing a whole turn.
- **Pagination** — searches return thousands; page through hits or rely on the
  MCP's top-N + the agent's curation. The UI only ever shows a **sample** of the
  corpus, never the full thousands.
- **Auth** — MCP credentials are server-side in the agent service, never exposed
  to the client or the model. ⛔ obtain from Alien.

## Boundary

The MCP is **read-only discovery/resolution of BnF holdings**. It does **not**:
- store the user's corpus (that's the app's Corpus service / DB),
- ingest or embed anything (that's the job runner + data cluster, doc 07),
- know about projects, sessions, notes, or memory.

Keep that separation crisp: MCP = "what exists at the BnF and what is this ARK";
the app owns "what's in *my* corpus and what have *we* done with it."
