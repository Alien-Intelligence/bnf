# 05 — App API & Agent Tools

Two surfaces:

1. **Agent tools** — the function-calling tools exposed to Claude. Most wrap the
   app's own services (so the agent can read/mutate corpus, notes, memory);
   a few wrap the BnF MCP (doc 06) and the RAG store.
2. **App REST/RPC** — what the web client calls. Largely a thin layer over the
   same services, plus streaming.

> Status: ✅ shape implied by the prototype · 🔶 proposed · ⛔ deferred.
> Schemas are JSON-Schema-ish sketches — tighten during implementation.

---

## 1. Agent tools

### Conventions
- All tools are **project-scoped**: the agent service injects `project_id` (and
  `session_id`) from context; the model does not pass them.
- Corpus-mutating tools operate on the project's **head corpus version** and may
  advance it (doc 03, doc 07).
- Every tool call is logged to `tool_call` (doc 03).

### Corpus tools (wrap Corpus service)

#### `corpus.get_state`
Return the current corpus summary so the agent knows what exists.
```json
{ "name": "corpus.get_state",
  "input": { "type": "object", "properties": {
    "include_sample": { "type": "boolean", "default": true },
    "sample_limit":   { "type": "integer", "default": 25 } } },
  "output": { "version": 7, "total": 1730,
              "facets": { "type": {...}, "lang": {...}, "source": {...}, "period": {...} },
              "sample": [ { "ark": "...", "title": "...", "year": 1889, "type": "press", ... } ] } }
```

#### `corpus.add`
```json
{ "name": "corpus.add",
  "input": { "arks": ["ark:/12148/…", "…"], "reason": "presse illustrée 1889" },
  "output": { "added": 412, "skipped_existing": 18, "version": 8, "stats": {...} } }
```
- Idempotent on already-present ARKs (reports `skipped_existing`).
- Resolves unknown ARKs' metadata via the MCP before insert (doc 06).

#### `corpus.remove`
```json
{ "name": "corpus.remove",
  "input": { "arks": ["…"], "reason": "lang != fr" },
  "output": { "removed": 206, "version": 9, "stats": {...} } }
```
- May also accept a **filter** form 🔶: `{ "where": { "lang": { "neq": "fr" } } }`
  to express "remove all English titles" without enumerating ARKs.

#### `corpus.stats`
Facet counts for the comprehension panel (or a subset).
```json
{ "name": "corpus.stats",
  "input": { "facets": ["type","lang","source","period"] },
  "output": { "total": 1730, "type": {...}, "lang": {...}, "source": {...}, "period": {...} } }
```

#### `corpus.diff`
The before/after delta between two versions (also used by the UI and ingest).
```json
{ "name": "corpus.diff",
  "input": { "from_version": 6, "to_version": 9 },
  "output": { "added": ["ark:…"], "removed": ["ark:…"],
              "added_count": 474, "removed_count": 208 } }
```

### Catalogue tools (wrap BnF MCP — doc 06)

#### `bnf.search`
```json
{ "name": "bnf.search",
  "input": { "query": "presse illustrée hebdomadaire Exposition 1889",
             "filters": { "date_from": "1889-05", "date_to": "1889-11",
                          "type": "press", "lang": "fre" },
             "limit": 50 },
  "output": { "total": 1240,
              "hits": [ { "ark": "ark:/12148/…", "title": "...", "author": "...",
                          "year": 1889, "type": "press", "lang": "fre",
                          "source": "gallica" }, ... ] } }
```
Exact filter vocabulary depends on the MCP — ⛔ confirm (doc 06).

#### `bnf.resolve`
Resolve full metadata (+ IIIF manifest) for one or more ARKs.
```json
{ "name": "bnf.resolve",
  "input": { "arks": ["ark:/12148/…"] },
  "output": { "documents": [ { "ark": "...", "title": "...", "pages": 6,
                               "iiif_manifest_url": "https://gallica.bnf.fr/iiif/…/manifest.json",
                               "raw_metadata": {...} } ] } }
```

### Ingestion tools (wrap Job runner — doc 07)
Usually triggered by the **UI**, but exposed to the agent so it can offer to
ingest 🔶.

#### `ingest.submit`
```json
{ "name": "ingest.submit",
  "input": { "target_version": 9 },     // defaults to head version
  "output": { "job_id": "…", "added_count": 474, "removed_count": 208, "status": "queued" } }
```

#### `ingest.status`
```json
{ "name": "ingest.status",
  "input": { "job_id": "…" },
  "output": { "status": "running", "stage": "embed", "progress": 0.52,
              "chunks_written": 18540, "eta_seconds": 4200 } }
```

### RAG tool (wrap data cluster — Step 3)

#### `rag.query`
```json
{ "name": "rag.query",
  "input": { "query": "accueil inauguration 6 mai 1889 presse quotidienne",
             "k": 12,
             "filters": { "type": ["press"], "year": { "lte": 1889 } } },   // optional, 🔶
  "output": { "passages": [ { "ark": "ark:/12148/…", "folio": 1,
                              "snippet": "PARIS, 6 MAI. — L'Exposition est ouverte…",
                              "score": 0.83, "title": "Le Figaro — 6 mai 1889" }, ... ] } }
```
- Scoped to the project's **ingested** version index. ⛔ exact query API is the
  cluster's; this is the contract the agent service adapts to.
- `folio` is essential — it carries into citations for IIIF deep-linking.

### Notes tools (wrap Notes service)

#### `note.create` / `note.update`
```json
{ "name": "note.create",
  "input": { "title": "Réception de l'inauguration",
             "body_md": "## Réception…\n- **Le Figaro** … [[ark:/12148/…|Le Figaro, 6 mai 1889|1]]" },
  "output": { "note_id": "…", "citation_count": 3 } }

{ "name": "note.update",
  "input": { "note_id": "…", "body_md": "…(revised)…" },
  "output": { "note_id": "…", "version": 4 } }
```
- The service **parses `[[ark|label|folio]]`** out of `body_md` into `citation`
  rows (doc 03). Reject/repair citations whose ARK isn't in the corpus 🔶.

#### `note.list` / `note.get`
```json
{ "name": "note.list", "input": {}, "output": { "notes": [ { "id":"…","title":"…","updated_at":"…","citation_count":3 } ] } }
{ "name": "note.get",  "input": { "note_id": "…" }, "output": { "title":"…","body_md":"…" } }
```

### Memory tools (wrap Memory service)

#### `memory.read`
```json
{ "name": "memory.read", "input": { "scope": "corpus" },
  "output": { "sections": [ { "title": "Périmètre du corpus",
                              "items": [ { "id":"…","text":"Langue : français uniquement","origin":"consigne" } ] } ] } }
```
Usually pre-loaded into the system prompt; the tool exists for explicit refresh.

#### `memory.write`
```json
{ "name": "memory.write",
  "input": { "scope": "corpus", "section": "Contraintes & filtres",
             "text": "Langue : français uniquement", "origin": "consigne" },
  "output": { "id": "…", "merged_into": null } }   // service may merge near-duplicates
```

#### `memory.forget`
```json
{ "name": "memory.forget", "input": { "id": "…" }, "output": { "ok": true } }
```
(Primarily user-driven via the × in the memory dialog, but available to the agent.)

---

## 2. App REST/RPC (client ↔ backend) 🔶

A thin layer over the same services, plus streaming. Suggested shape:

```
# Projects
GET    /projects
POST   /projects
GET    /projects/:id

# Corpus
GET    /projects/:id/corpus?version=head        -> stats + sample + facets
GET    /projects/:id/corpus/documents?facet…    -> filtered document list (the panel)
GET    /projects/:id/corpus/documents/:ark      -> detail (the doc side panel)
GET    /projects/:id/corpus/diff?from=&to=

# Sessions (corpus + research)
GET    /projects/:id/sessions?scope=corpus|research
POST   /projects/:id/sessions
GET    /sessions/:sid/messages
POST   /sessions/:sid/messages                  -> user turn; streams the agent turn (SSE)

# Ingestion
POST   /projects/:id/ingest                     -> { job_id }
GET    /ingest/:job_id                           -> status/stage/progress (poll or SSE)

# Notes
GET    /projects/:id/notes
POST   /projects/:id/notes
GET    /notes/:nid     PUT /notes/:nid
GET    /projects/:id/notes/export                -> compiled "Carnet" Markdown

# Memory
GET    /projects/:id/memory?scope=
POST   /projects/:id/memory
DELETE /projects/:id/memory/:item_id
```

### Streaming contract ✅
`POST /sessions/:sid/messages` streams Server-Sent Events so the UI can render
the same things the prototype shows live:
```
event: token        data: {"text":"412 titres…"}
event: tool_call    data: {"tool":"bnf.search","input":{...}}
event: tool_result  data: {"tool":"bnf.search","output":{"total":1240}}
event: corpus_event data: {"kind":"add","count":412,"version":8}
event: note_event   data: {"kind":"created","note_id":"…","title":"…"}
event: done         data: {"message_id":"…"}
```
These map 1:1 to the prototype's tool chips, "+N documents" events, and "Note
créée" events.
