@AGENTS.md

# BnF Corpus Research — Project Context for Claude

This file is the orientation document for any Claude session working in this
repo. It complements (it does not replace) the parent
[`../../CLAUDE.md`](../../CLAUDE.md) which carries the platform-wide rules
(workflow, security, agent delegation).

## What this project is

A research workspace for **Bibliothèque nationale de France** librarians and
scholars. Three steps:

1. **Constituer** — a Claude agent + the BnF MCP build a corpus of
   ARK-identified documents over many sessions, with persistent project memory.
2. **Ingérer** — an async backend **job** runs custom fast chunk/embed
   scripts and indexes the **delta** into the data cluster (RAG store).
3. **Rechercher** — a RAG-backed Claude agent answers questions over the
   ingested corpus, cites sources by **ARK + folio** (IIIF deep-links), and
   writes Markdown research notes that persist across sessions.

The product is co-branded **Alien Intelligence × BnF**. Working language:
**French**. Default Next.js locale: `fr`.

## Where to find what

### Design intent — `design/docs/`
The frozen design handoff. Read these before implementing anything new.

| Doc | When to read it |
|---|---|
| [01 Product overview](design/docs/01-product-overview.md) | First. Always. |
| [02 Architecture](design/docs/02-architecture.md) | Before changing service boundaries |
| [03 Data model](design/docs/03-data-model.md) | Before any schema work |
| [04 Agent flows](design/docs/04-agent-flows.md) | Before touching the agent loops |
| [05 App API & agent tools](design/docs/05-app-api-and-agent-tools.md) | Before adding an endpoint or a tool |
| [06 BnF MCP](design/docs/06-bnf-mcp.md) | Before touching MCP integration or IIIF |
| [07 Ingestion jobs & corpus delta](design/docs/07-ingestion-jobs-and-corpus-delta.md) | Before touching ingest |
| [08 Prompting](design/docs/08-prompting.md) | Before editing system prompts |
| [09 Open questions](design/docs/09-open-questions-for-builder.md) | When you hit something the design defers |

The prototype HTML (`design/BnF Corpus Research.dc.html`) is a **scripted
demo** — useful for UX contracts and data shapes; not authoritative code.

### Engineering rules — `playbook/`
The rulebook this codebase follows. Read these before writing any feature code.

| Domain | Rules |
|---|---|
| App skeleton | [page-structure](playbook/page-structure.md), [page-client-split](playbook/page-client-split.md), [componentization](playbook/componentization.md), [forms](playbook/forms.md), [ui-states](playbook/ui-states.md), [new-primitives](playbook/new-primitives.md) |
| Data flow | [hooks](playbook/hooks.md), [client-patterns](playbook/client-patterns.md), [api-routes](playbook/api-routes.md), [api-layers](playbook/api-layers.md), [models](playbook/models.md), [constants](playbook/constants.md), [i18n](playbook/i18n.md) |
| BnF-specific | [corpus-versioning](playbook/corpus-versioning.md), [agent-streaming](playbook/agent-streaming.md), [mcp-client](playbook/mcp-client.md), [ingestion-jobs](playbook/ingestion-jobs.md), [citations](playbook/citations.md), [memory](playbook/memory.md) |

[`playbook/README.md`](playbook/README.md) is the index. When a rule says
"forbidden", code review rejects it.

## Tech stack ✅

- **Next.js 16** (App Router) — this is **not** the Next.js Claude knows.
  Read the relevant guide in `node_modules/next/dist/docs/` before writing
  any code (see [AGENTS.md](AGENTS.md)).
- **React 19**, **TypeScript 5**, **Tailwind 4**.
- **shadcn/ui** for UI primitives (`components/ui/`).
- **next-intl** for i18n (default locale: `fr`).
- **TanStack Query** for client data — never raw `fetch` from components.
- **react-hook-form + Zod** for forms (one schema shared by form + API).
- **Prisma 7** with Postgres (per the alien-agents convention; schema in
  `prisma/schema.prisma`).
- **Anthropic SDK** for the Claude agent loops (Sonnet-class for both corpus
  and research agents).
- **SSE** (`text/event-stream`) for agent turn streaming. **Not**
  `EventSource` — the client uses `fetch` + a streaming parser because the
  user message body is `POST`ed.

The data cluster (RAG store) and the BnF MCP are ⛔ **provisioned outside
this repo**. This app integrates with them through documented contracts —
see [playbook/mcp-client.md](playbook/mcp-client.md) and
[playbook/ingestion-jobs.md](playbook/ingestion-jobs.md).

## Repository layout (target)

```
bnf/
├── app/                          # Next.js App Router
│   ├── [locale]/
│   │   ├── layout.tsx
│   │   └── (workspace)/
│   │       └── projects/[id]/
│   │           ├── constituer/   page.tsx + client.tsx
│   │           ├── ingerer/      page.tsx + client.tsx
│   │           └── rechercher/   page.tsx + client.tsx
│   │                └── carnet/  page.tsx
│   └── api/
│       ├── _middleware.ts        # withAuth
│       ├── _helpers.ts           # parseBody
│       ├── projects/[id]/corpus/{route,add,remove,diff}.ts
│       ├── sessions/[sid]/messages/route.ts    # SSE
│       ├── projects/[id]/ingest/route.ts       # POST submit
│       ├── ingest/[job_id]/route.ts            # GET status
│       ├── projects/[id]/notes/route.ts
│       └── projects/[id]/memory/route.ts
│
├── components/
│   ├── ui/                       # shadcn primitives (do not edit lightly)
│   ├── cards/<feature>/<name>.tsx
│   ├── sheets/<feature>/<name>.tsx
│   ├── dialogs/<feature>/<name>.tsx
│   ├── badges/<feature>/<name>.tsx
│   ├── charts/<feature>/<name>.tsx
│   ├── layouts/<feature>/<name>.tsx
│   ├── tabs/<feature>/<name>.tsx
│   └── forms/<feature>/<name>.tsx
│
├── models/                       # five files per model — see playbook/models.md
│   ├── projects/{schema,queries,service,policy,types}.ts
│   ├── corpus/{schema,queries,service,policy,types,versioning}.ts
│   ├── documents/…
│   ├── sessions/…
│   ├── messages/…
│   ├── memory/…
│   ├── notes/…
│   ├── ingest/…
│   └── users/…
│
├── lib/
│   ├── db.ts                     # Prisma client
│   ├── auth.ts                   # session resolution
│   ├── bouncer.ts                # authorization dispatcher
│   ├── api-fetch.ts              # client-side fetch wrapper (basePath-aware)
│   ├── api-response.ts           # ok / notFound / unauthorized / forbidden
│   ├── constants.ts              # cross-cutting strings, numbers, IIIF templates
│   ├── agent/
│   │   ├── loop.ts               # the streaming agent loop
│   │   ├── tools.ts              # AGENT_TOOLS constants + registry
│   │   ├── dispatch.ts           # tool_name → handler
│   │   └── prompts/{shared,corpus,research}.ts
│   ├── mcp/
│   │   ├── bnf-client.ts         # the only thing that talks MCP
│   │   └── normalize.ts          # MCP → app shape maps
│   ├── citations/
│   │   ├── syntax.ts             # [[ark|label|folio]] parser/renderer
│   │   └── external.ts           # derive IIIF / Gallica URLs
│   ├── sse/
│   │   ├── emitter.ts            # server: write typed events
│   │   └── consume.ts            # client: parse the stream
│   └── jobs/
│       └── runner.ts             # ingest job runner adapter
│
├── hooks/
│   └── api/                      # one file per model — TanStack Query hooks
│
├── messages/
│   ├── fr.json                   # primary
│   └── en.json
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── design/                       # frozen design handoff — DO NOT EDIT
│   └── docs/01-…09-…
│
├── playbook/                     # engineering rules — read first
│   └── …
│
├── AGENTS.md                     # Next.js + user/date metadata
└── CLAUDE.md                     # this file
```

## The four-phase workflow applies here too

The parent CLAUDE.md mandates **Research → Plan → Implement → Validate** for
every feature. The BnF project is no exception. For this repo specifically:

- **Research** — read the relevant doc in `design/docs/` and the matching
  rule(s) in `playbook/`. The design is frozen; the playbook is the
  implementation contract.
- **Plan** — write the plan in
  `../../ai-memories/tech/repos/bnf/<feature-name>/plan/implementation-plan.md`
  (the project is single-repo, so `tech/repos/bnf/`, not `tech/platform/`).
- **Implement** — follow the playbook. Every rule. No quiet exceptions.
- **Validate** — run lint, type-check, and at minimum the smoke path:
  `yarn dev`, navigate to the affected page, exercise the golden path.

## Hard rules specific to this project

These show up across multiple playbook files and matter enough to repeat here.

### ARK is the document identity ✅
`ark:/12148/...`. Opaque, never constructed, never mutated. The natural key
for documents. The membership key for corpus versions. The citation key in
notes. See [playbook/mcp-client.md](playbook/mcp-client.md).

### Folio is mandatory in citations ✅
`[[ark|label|folio]]`. Folio is what makes "click → open the exact page on
the BnF" work. No folio, no citation — the agent must say so in prose
instead of inventing one. See [playbook/citations.md](playbook/citations.md).

### Corpus is versioned, ingestion is a delta ✅
`project.head_version_id` (current) and `project.ingested_version_id` (last
successfully ingested) are the two pointers. `advanceVersion()` is the
**only** function that creates a new version; `IngestService.commit()` is
the **only** function that moves the ingested pointer. See
[playbook/corpus-versioning.md](playbook/corpus-versioning.md).

### Ingestion is asynchronous ✅
"Le traitement continue côté serveur." A user can close the tab and come
back hours later. Never block a request on a job. Four stages,
`extract → chunk → embed → index`, with per-stage progress. See
[playbook/ingestion-jobs.md](playbook/ingestion-jobs.md).

### Project memory ≠ session context ✅
Memory is a small curated fact list re-injected at the start of every
session. It does **not** "fill up". The conversation context fills up; the
memory does not. Confusing the two is the most common modeling error in this
domain. See [playbook/memory.md](playbook/memory.md).

### Streaming agent turns are SSE ✅
`POST /api/sessions/:sid/messages` returns `text/event-stream`. The event
vocabulary is fixed (`token`, `tool_call`, `tool_result`, `corpus_event`,
`memory_event`, `note_event`, `ingest_event`, `done`, `error`). Every tool
call is persisted to `tool_call`. The route still parses and authorizes
before returning the stream. See
[playbook/agent-streaming.md](playbook/agent-streaming.md).

### French is the default locale ✅
All user-facing strings are translation keys in `messages/fr.json` and
`messages/en.json` — both files updated in the same commit. The agent's
streamed output is **not** passed through i18n; it comes back in French
from the prompts. See [playbook/i18n.md](playbook/i18n.md).

## Local dev

```bash
# Install
npm install

# Database (per the platform convention — see ../../CLAUDE_DATABASE.md)
# Prisma 7 reads its connection from prisma.config.ts.
npx prisma generate
npx prisma migrate dev

# Run
npm run dev    # http://localhost:3000

# Lint
npm run lint
```

Environment variables (server-only):

```bash
# .env.local — never committed
DATABASE_URL=postgresql://…
ANTHROPIC_API_KEY=sk-ant-…
BNF_MCP_URL=https://…
BNF_MCP_TOKEN=…
CLUSTER_API_URL=https://…
CLUSTER_API_TOKEN=…
JOB_CALLBACK_SECRET=…              # for /internal/ingest/:job_id/* webhooks
```

Each required var **throws at startup** if missing — no defaults. See the
"empty-defaults anti-pattern" in the platform-wide
[`CLAUDE_ERROR_PATTERNS.md`](../../CLAUDE_ERROR_PATTERNS.md).

## When in doubt

- **UX contract question** → [`design/docs/01-product-overview.md`](design/docs/01-product-overview.md)
- **"Where does this file go?"** → [`playbook/models.md`](playbook/models.md)
  or [`playbook/componentization.md`](playbook/componentization.md)
- **"Should I create a new shadcn primitive?"** → [`playbook/new-primitives.md`](playbook/new-primitives.md)
  (almost always: no)
- **"How do I add an endpoint?"** → [`playbook/api-routes.md`](playbook/api-routes.md)
  + [`playbook/api-layers.md`](playbook/api-layers.md)
- **"How do I add an agent tool?"** → [`playbook/agent-streaming.md`](playbook/agent-streaming.md)
  (handler in `lib/agent/dispatch.ts`, label key in `messages/*.json`,
  constant in `lib/agent/tools.ts`)
- **"Something is unspecified in the design"** → [`design/docs/09-open-questions-for-builder.md`](design/docs/09-open-questions-for-builder.md);
  if it isn't there either, ask the user before deciding.

## Things deliberately settled (do NOT reopen without reason)

From [`design/docs/09 §G`](design/docs/09-open-questions-for-builder.md#g-things-deliberately-settled-do-not-reopen-without-reason):

- ✅ ARK is the document identity and citation key.
- ✅ Citation syntax is `[[ark|label|folio]]`; folio deep-links to IIIF.
- ✅ Project **memory is durable and curated**, separate from session/chat
  context.
- ✅ The corpus is **versioned**; ingestion is a **delta** operation.
- ✅ Ingestion is **asynchronous** with a 4-stage progress model.
- ✅ Step 1 always gives the librarian **corpus comprehension** (stats,
  facets, period histogram). Filter drawer collapsed by default; chat
  **40%**, workspace **60%**.
- ✅ Each interactive step has a guided onboarding intro (auto-shows once,
  re-openable via `?` button).
- ✅ Atelier vs. Carnet are two **views** over the same notes, not two data
  models.

## Suggested build order

Per [`design/docs/09 — Suggested build order`](design/docs/09-open-questions-for-builder.md#suggested-build-order-):

1. Data model + Corpus service (CRUD, versioning, diff, facets) — unblocks the UI.
2. BnF MCP client + `bnf.search`/`bnf.resolve` — real documents flow in.
3. Corpus agent loop (Step 1) with streaming + memory.
4. Job runner + ingestion contract (stub cluster scripts behind the contract first).
5. RAG `rag.query` + research agent (Step 3) + notes.
6. Memory service hardening (merge/dedupe), Carnet export, polish.

Pick one slice at a time. Don't try to implement Step 3 before Step 1's
corpus state is real.
