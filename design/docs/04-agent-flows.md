# 04 — Agent Flows

Two agent loops: the **corpus-building agent** (Step 1) and the **research
agent** (Step 3). Both are multi-turn, multi-session, and grounded in
**persistent project memory**. Step 2 is not an agent — it is a job (doc 07).

> The tool names below are defined with full schemas in
> [doc 05](05-app-api-and-agent-tools.md). The system prompts are in
> [doc 08](08-prompting.md).

---

## Session lifecycle (both agents)

```
open/resume session
   │
   ├─ load project memory  ──► inject into system prompt
   ├─ load session history  ──► prior messages (resume)
   ├─ load current state    ──► corpus stats (Step 1) / corpus is ingested (Step 3)
   ▼
loop:
   user message
     │
     ▼
   agent turn (streamed):
     • reason
     • call tools (0..N)  ──► execute against app API / MCP / RAG
     • observe results, maybe call more tools
     • produce assistant text (+ side effects: corpus mutated / note written)
     • optionally call memory.write(...) to record a durable fact
     │
     ▼
   persist messages + tool_calls; update session.updated_at
```

**Memory vs. context.** Session history is the conversation (can be summarized
if long — standard context management). **Project memory is separate**: a small,
curated, durable fact list, always re-read at session start. It is the answer to
"how does the agent know what we decided three sessions ago." It does **not**
grow unbounded — facts are merged/updated, and the user can prune them.

---

## Flow A — Corpus building (Step 1)

### Goal
Grow a high-quality corpus of ARK-identified documents matching the project's
scope, iteratively, over many sessions.

### Tools used
`bnf.search` (MCP), `bnf.resolve` (MCP), `corpus.get_state`, `corpus.add`,
`corpus.remove`, `corpus.stats`, `corpus.diff`, `memory.read`, `memory.write`.

### Turn shape (matches prototype `BUILD_SCRIPT`)

```
User:  "Ajoute la presse illustrée et les hebdomadaires couvrant l'inauguration."
Agent:
  → bnf.search { query: "presse illustrée hebdomadaire Exposition 1889",
                 filters: { date_from: 1889-05, date_to: 1889-11, type: press } }
     ← 1240 catalogue hits (ARKs + brief metadata)
  → (agent dedupes editions, filters to scope, picks the relevant set)
  → corpus.add { arks: [...], reason: "presse illustrée 1889" }
     ← { added: 412, corpus_version: 7, stats: {...} }
  Assistant text: "412 titres ajoutés après dédoublonnage… deux titres
                   anglophones repérés, je vous les signalerai."
  → memory.write { scope: corpus, section: "Décisions de session",
                   text: "Presse illustrée ajoutée (412)", origin: "action" }   (optional)
```

The UI reflects each step: the **tool chip** (`bnf.search · via MCP`), then an
**event** ("+412 documents ajoutés"), then the agent's reasoning, while the
right panel's stats/facets/histogram **recompute live**.

### Key behaviors the agent must have
- **Know the current corpus** before acting — call `corpus.get_state` /
  `corpus.stats` at the start of a session and after mutations, so it doesn't
  re-add what's already there and can reason about gaps.
- **Respect memory constraints** — e.g. "français uniquement" means it should
  flag or exclude non-French results (the prototype's "remove English" turn).
- **Deduplicate editions** — multiple ARKs can be reprints/editions of the same
  title; collapse per the project's rules.
- **Be honest about scale** — searches return thousands; the agent curates and
  reports counts. The corpus is sampled in the UI ("aperçu de 18 sur 1 730").
- **Propose, then mutate** — for large adds, it's fine to add directly and report
  (as the prototype does), but destructive ops (large removes) should be clearly
  narrated and ideally confirmable 🔶.

### Multi-session continuity
Each session is a thread (e.g. "Recherche initiale — presse", "Presse illustrée
1889", "Iconographie & estampes"). Resuming a session restores its transcript;
**all** sessions share the one project corpus and the one project memory. The
prototype models this with session "snapshots"; in the product, sessions simply
read/write the same live corpus + memory.

---

## Flow B — Research (Step 3)

### Precondition
The corpus has an **ingested** version (Step 2 done). `rag.query` targets that
version's index.

### Tools used
`rag.query`, `doc.get`, `note.create`, `note.update`, `note.list`, `note.get`,
`memory.read`, `memory.write`.

### Turn shape (matches prototype `R_SCRIPT`)

```
User:  "Comment la presse quotidienne a-t-elle accueilli l'inauguration du 6 mai 1889 ?"
Agent:
  → rag.query { query: "accueil inauguration 6 mai 1889 presse quotidienne", k: 12 }
     ← 14 passages, each with { ark, folio, snippet, score }
  → (agent synthesizes, grounded ONLY in retrieved passages)
  Assistant text: "L'accueil est largement enthousiaste. Le Figaro (6 mai)…",
                  cites: [ {label:"Le Figaro — 6 mai", ark:…, vue:1}, … ]
  → note.create { title: "Réception de l'inauguration",
                  body_md: "## Réception…\n- **Le Figaro** … [[ark:…|Le Figaro, 6 mai 1889|1]]" }
     ← { note_id, … }
  (UI: opens the note as a tab; event chip "Note créée · Réception de l'inauguration")
```

### Key behaviors
- **Cite everything** — every claim ties to retrieved passages, rendered as
  `[[ark|label|folio]]` in notes and as `cites[]` chips on chat answers. No
  uncited assertions. If retrieval is weak, say so rather than confabulate.
- **Folio-level citations** — carry the `vue`/folio from the retrieved passage so
  the side panel can deep-link to the exact page in the IIIF viewer.
- **Write durable artifacts** — consolidate answers into Markdown notes; update
  an existing note rather than spawning duplicates when the topic matches
  (`note.list` → decide create vs. update) 🔶.
- **Maintain research memory** — record the question, angle, key sources, and
  working hypotheses (the prototype's research memory sections).

### Atelier vs. Carnet (UI, not agent behavior)
- **Atelier** — chat + the active note as tabs (working).
- **Carnet** — all notes stitched into one exportable document (reading/sharing).
Both are pure views over the same `note` rows; the agent is identical.

---

## Where memory gets written (both flows)

The agent should call `memory.write` when it learns something **durable about
the project** — scope decisions, constraints, source preferences, established
findings/hypotheses — not for transient chatter. Writes are **upserts into a
section**; the service deduplicates/merges similar facts 🔶. The user can edit or
remove any fact (the × in the memory dialog → `memory.forget`).

A reasonable policy (tune in prompt, doc 08):
- Step 1: record scope, period, language/source constraints, and notable
  add/remove decisions.
- Step 3: record the research question, method, recurring key sources, and
  hypotheses as they form.
