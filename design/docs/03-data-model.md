# 03 — Data Model

> Status: ✅ shapes fixed by the prototype/UX · 🔶 proposed · ⛔ deferred.
> SQL is illustrative (Postgres dialect). IDs are `uuid` unless noted.

## Entity map

```
project ──1:N── session ──1:N── message
   │                              └─ tool_call (log)
   │
   ├──1:N── document            (metadata projection, keyed by ARK)
   ├──1:N── corpus_version ──N:M── document   (membership = the corpus at a point in time)
   │            └─1:N── ingest_job
   ├──1:N── memory_item         (sectioned, persistent facts)
   └──1:N── note                (Markdown artifacts) ──1:N── note_version
                                                       └─ citation (ark + folio)
```

## project ✅
The top-level workspace (the prototype's `p1` / `p2`).

```sql
create table project (
  id            uuid primary key,
  name          text not null,             -- "Exposition Universelle 1889"
  subtitle      text,                       -- "Corpus · presse 1889"
  owner_id      uuid not null,
  created_at    timestamptz not null default now(),
  -- denormalized pointers for fast load:
  head_version_id        uuid,             -- current (possibly un-ingested) corpus version
  ingested_version_id    uuid              -- last successfully ingested version
);
```

## document ✅
A **metadata projection** of a BnF notice, keyed by ARK. Populated by resolving
ARKs through the BnF MCP. This is the canonical record the corpus panel renders
(matches the prototype's `SEED` shape).

```sql
create table document (
  ark         text not null,               -- "ark:/12148/bpt6k2839841"  (the natural key)
  project_id  uuid not null references project(id),
  title       text not null,
  author      text,
  year        int,                          -- may be a single year; ranges handled in UI bins
  doc_type    text not null,                -- press|image|estampe|book|map|manuscript|enlum|charte|…
  lang        text,                         -- fr|en|la|…
  source      text,                         -- gallica|retronews|databnf|arsenal|archives37|…
  pages       int,
  excerpt     text,                         -- short OCR snippet for the detail panel
  iiif_manifest_url text,                   -- canonical IIIF manifest if known
  raw_metadata jsonb,                       -- full MCP/notice payload
  resolved_at timestamptz,
  primary key (project_id, ark)
);
```

Notes:
- `doc_type` / `lang` / `source` vocabularies are **open** and drive facets.
  The prototype hard-codes labels/colors in `TYPES`/`SOURCES`; in the product,
  keep a small reference table or config mapping `code → {label, color}` 🔶.
- Faceting (counts by type/lang/source/period) is computed over the **current
  corpus version's membership**, not over all documents.

## corpus_version ✅ (central to incremental ingest — see doc 07)
An **immutable snapshot** of which documents constitute the corpus at a point in
time. Every meaningful corpus edit creates (or advances toward) a new version.

```sql
create table corpus_version (
  id          uuid primary key,
  project_id  uuid not null references project(id),
  seq         int  not null,                -- monotonic per project: 1,2,3…
  created_at  timestamptz not null default now(),
  created_by  text,                          -- 'agent:session:<id>' | 'user'
  note        text,                          -- "Removed English-language titles"
  status      text not null,                 -- draft|sealed|ingested|failed
  parent_id   uuid references corpus_version(id),
  unique (project_id, seq)
);

create table corpus_membership (              -- N:M version ↔ document
  version_id  uuid not null references corpus_version(id),
  ark         text not null,
  project_id  uuid not null,
  primary key (version_id, ark)
);
```

A **delta** between two versions is `membership(v2) − membership(v1)` (added)
and `membership(v1) − membership(v2)` (removed). See doc 07.

🔶 Implementation choice: store full membership per version (simple, diff at
query time) **or** store base + change-sets. Full membership is simplest and the
sets are small (thousands of ARKs); start there.

## session ✅
A resumable conversation thread, in one of two scopes.

```sql
create table session (
  id          uuid primary key,
  project_id  uuid not null references project(id),
  scope       text not null,                -- 'corpus' | 'research'
  title       text not null,                -- "Presse illustrée 1889"
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null,
  status      text                           -- active|draft|archived
);
```

## message + tool_call ✅
The turn-by-turn transcript, so sessions resume with full history.

```sql
create table message (
  id          uuid primary key,
  session_id  uuid not null references session(id),
  seq         int not null,
  role        text not null,                -- user|assistant|event
  content     text,
  created_at  timestamptz not null default now(),
  unique (session_id, seq)
);

create table tool_call (                      -- structured log of agent tool use
  id          uuid primary key,
  message_id  uuid not null references message(id),
  tool        text not null,                -- bnf.search | corpus.add | rag.query | note.create | …
  input       jsonb not null,
  output      jsonb,
  status      text not null,                -- ok|error
  latency_ms  int,
  created_at  timestamptz not null default now()
);
```

The prototype's `event` messages (e.g. "+412 documents", "Session reprise",
"Note créée") map to `role='event'` rows or are derived from `tool_call`s.

## memory_item ✅
Per-**project** persistent facts (global, not per-session). Sectioned, with a
provenance tag, user-removable — exactly the memory dialog in the prototype.

```sql
create table memory_item (
  id          uuid primary key,
  project_id  uuid not null references project(id),
  scope       text not null,                -- 'corpus' | 'research'  (the prototype shows different sections per step)
  section     text not null,                -- "Périmètre du corpus", "Contraintes & filtres", …
  text        text not null,                -- "Langue : français uniquement"
  origin      text,                          -- 'consigne' | 'déduit' | 'action · session 2' | …
  created_at  timestamptz not null default now(),
  position    int                            -- ordering within section
);
```

Memory is **read into the agent's system prompt** at session start and **written
back** when the agent records a durable fact (doc 04, doc 08). It is *not* a
chat-context buffer and does not "fill up" — it is a curated fact list.

## note + note_version + citation ✅
Markdown research artifacts produced in Step 3.

```sql
create table note (
  id          uuid primary key,
  project_id  uuid not null references project(id),
  session_id  uuid,                          -- session that created it (nullable; notes outlive sessions)
  title       text not null,
  body_md     text not null,                 -- Markdown with inline [[ark|label|vue]] citations
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null,
  pinned      boolean default false
);

create table note_version (                   -- 🔶 keep history; the agent rewrites notes
  id        uuid primary key,
  note_id   uuid not null references note(id),
  seq       int not null,
  body_md   text not null,
  created_at timestamptz not null default now()
);

create table citation (                        -- extracted from note bodies for indexing / the side panel
  id        uuid primary key,
  note_id   uuid not null references note(id),
  ark       text not null,
  folio     int,                              -- the IIIF "vue" (f<n>)
  label     text
);
```

### Citation syntax ✅
In note Markdown, a citation is `[[<ark>|<label>|<folio>]]`, e.g.

```
…« fête du travail et de la paix ». [[ark:/12148/bpt6k2839841|Le Figaro, 6 mai 1889|1]]
```

The renderer turns this into an inline ARK pill; clicking it opens the citation
side panel. External links are derived (doc 06):
- IIIF image: `https://gallica.bnf.fr/<ark>/f<folio>/full/full/0/native.jpg`
- Gallica item: `https://gallica.bnf.fr/<ark>/f<folio>.item`
- IIIF manifest: `https://gallica.bnf.fr/iiif/<ark>/manifest.json`

## ingest_job ✅ (detailed in doc 07)

```sql
create table ingest_job (
  id              uuid primary key,
  project_id      uuid not null references project(id),
  target_version_id uuid not null references corpus_version(id),
  base_version_id   uuid references corpus_version(id),  -- last ingested; null for first ingest
  status          text not null,            -- queued|running|done|failed|canceled
  stage           text,                      -- extract|chunk|embed|index
  progress        numeric,                   -- 0..1 overall
  added_count     int,                       -- docs in the delta to add
  removed_count   int,                       -- docs to tombstone in the index
  chunks_written  int,
  stats           jsonb,                      -- per-stage timings/counts
  error           text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
```
