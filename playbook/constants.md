# Constants and Enums Rule

## Rule

No magic strings or magic numbers inline in JSX, services, or route handlers.
Every domain value that names a state, scope, type, or configuration parameter
is a named constant or enum. Repetition is the smell — if the same string
appears in two files, it belongs in a constant.

## Where constants live

### Domain values (status, scope, type) → `models/<model>/schema.ts`

Status values, scopes, and types that describe what a model can be are defined
next to the schema that uses them. They are not scattered across components
or routes.

```ts
// models/corpus/schema.ts
export const CORPUS_VERSION_STATUS = {
  DRAFT: "draft",
  SEALED: "sealed",
  INGESTED: "ingested",
  FAILED: "failed",
} as const
export type CorpusVersionStatus =
  (typeof CORPUS_VERSION_STATUS)[keyof typeof CORPUS_VERSION_STATUS]

// models/sessions/schema.ts
export const SESSION_SCOPE = { CORPUS: "corpus", RESEARCH: "research" } as const
export type SessionScope = (typeof SESSION_SCOPE)[keyof typeof SESSION_SCOPE]

// models/ingest/schema.ts
export const INGEST_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELED: "canceled",
} as const
export type IngestStatus = (typeof INGEST_STATUS)[keyof typeof INGEST_STATUS]

export const INGEST_STAGE = {
  EXTRACT: "extract",
  CHUNK: "chunk",
  EMBED: "embed",
  INDEX: "index",
} as const
export type IngestStage = (typeof INGEST_STAGE)[keyof typeof INGEST_STAGE]

// models/messages/schema.ts
export const MESSAGE_ROLE = { USER: "user", ASSISTANT: "assistant", EVENT: "event" } as const

// models/memory/schema.ts
export const MEMORY_SCOPE = { CORPUS: "corpus", RESEARCH: "research" } as const
```

Both the service writing status and the badge displaying it import from the
same source:

```ts
// models/ingest/service.ts
await prisma.ingestJob.update({ where: { id }, data: { status: INGEST_STATUS.RUNNING } })
```

```tsx
// components/badges/ingest/status.tsx
import { INGEST_STATUS, type IngestStatus } from "@/models/ingest/schema"

const variant = {
  [INGEST_STATUS.QUEUED]:   "secondary",
  [INGEST_STATUS.RUNNING]:  "outline",
  [INGEST_STATUS.DONE]:     "success",
  [INGEST_STATUS.FAILED]:   "destructive",
  [INGEST_STATUS.CANCELED]: "secondary",
} satisfies Record<IngestStatus, string>
```

### App-wide configuration → `lib/constants.ts`

Cross-cutting values (default models, MCP endpoints, polling intervals, IIIF
templates) live in `lib/constants.ts`.

```ts
// lib/constants.ts

// Models
export const CORPUS_AGENT_MODEL = "claude-sonnet-4-6"
export const RESEARCH_AGENT_MODEL = "claude-sonnet-4-6"

// Ingest UX timing
export const INGEST_POLL_INTERVAL_MS = 5_000
export const INGEST_ETA_REFRESH_MS = 30_000

// Corpus comprehension UI
export const CORPUS_SAMPLE_LIMIT = 25
export const CORPUS_FACET_TOP_N = 12

// IIIF / Gallica templates (see mcp-client.md and citations.md)
export const IIIF_IMAGE_URL = (ark: string, folio: number) =>
  `https://gallica.bnf.fr/${ark}/f${folio}/full/full/0/native.jpg`
export const GALLICA_ITEM_URL = (ark: string, folio: number) =>
  `https://gallica.bnf.fr/${ark}/f${folio}.item`
export const IIIF_MANIFEST_URL = (ark: string) =>
  `https://gallica.bnf.fr/iiif/${ark}/manifest.json`

// Memory write policy
export const MEMORY_DEDUPE_SIMILARITY = 0.9
```

### Route paths reused across files → `lib/constants.ts`

If a route string appears in more than one file, it moves here:

```ts
// lib/constants.ts
export const ROUTES = {
  projects: "/projects",
  projectNew: "/projects/new",
  projectDetail: (id: string) => `/projects/${id}`,
  constituer: (id: string) => `/projects/${id}/constituer`,
  ingerer:    (id: string) => `/projects/${id}/ingerer`,
  rechercher: (id: string) => `/projects/${id}/rechercher`,
  carnet:     (id: string) => `/projects/${id}/rechercher/carnet`,
  session:    (sid: string) => `/sessions/${sid}`,
} as const
```

```tsx
import { ROUTES } from "@/lib/constants"
<Link href={ROUTES.constituer(projectId)}>{t("constituer")}</Link>

// ❌ Hardcoded in JSX
<Link href={`/projects/${projectId}/constituer`}>{t("constituer")}</Link>
```

### API endpoint paths used by a single hook → top of that hook file

If an API path is only used in one file, define it as a constant at the top.
It moves to `lib/constants.ts` once a second file references it.

```ts
// hooks/api/corpus.ts
const CORPUS_ENDPOINT = (projectId: string) => `/api/projects/${projectId}/corpus`
```

### Magic numbers → named constants wherever they appear

Polling intervals, page sizes, retry limits, similarity thresholds, max
context lengths — any number whose meaning isn't self-evident.

```ts
// ✅ Named
const SESSION_RESUME_MAX_TURNS = 100
const RAG_DEFAULT_K = 12
const MEMORY_SECTION_MAX_ITEMS = 50

// ❌ Unnamed
ragQuery(question, 12)
```

## ARK and folio are not constants — they are data

Note: an ARK like `ark:/12148/bpt6k2839841` is data, not a constant. Don't
put example ARKs in `lib/constants.ts`. Test fixtures live in test files.

The **citation syntax** `[[ark|label|folio]]` is itself a constant — the
delimiters belong in `lib/citations.ts` (see [citations.md](citations.md)).

## BnF MCP tool names — constants in `lib/mcp/`

```ts
// lib/mcp/tools.ts
export const BNF_TOOLS = {
  SEARCH:  "bnf.search",
  RESOLVE: "bnf.resolve",
} as const

// lib/agent/tools.ts — the agent-facing tool names
export const AGENT_TOOLS = {
  CORPUS_GET_STATE: "corpus.get_state",
  CORPUS_ADD:       "corpus.add",
  CORPUS_REMOVE:    "corpus.remove",
  CORPUS_STATS:     "corpus.stats",
  CORPUS_DIFF:      "corpus.diff",
  BNF_SEARCH:       "bnf.search",
  BNF_RESOLVE:      "bnf.resolve",
  INGEST_SUBMIT:    "ingest.submit",
  INGEST_STATUS:    "ingest.status",
  RAG_QUERY:        "rag.query",
  NOTE_CREATE:      "note.create",
  NOTE_UPDATE:      "note.update",
  NOTE_LIST:        "note.list",
  NOTE_GET:         "note.get",
  MEMORY_READ:      "memory.read",
  MEMORY_WRITE:     "memory.write",
  MEMORY_FORGET:    "memory.forget",
} as const
```

These are referenced by the tool dispatcher, the SSE event emitter, the
`tool_call` log writer, the `BadgeToolCall` component, and the i18n strings
that label each tool in French.

## Anti-patterns (FORBIDDEN)

```tsx
// ❌ Inline status string
if (job.status === "running") { ... }
// Use: if (job.status === INGEST_STATUS.RUNNING) { ... }

// ❌ Same route in 3 files
<Link href="/projects/new">             // page A
router.push("/projects/new")            // dialog B
href: "/projects/new"                   // sidebar C
// Use: ROUTES.projectNew

// ❌ Magic interval
setInterval(refetch, 5000)
// Use: setInterval(refetch, INGEST_POLL_INTERVAL_MS)

// ❌ Magic top-N for facets
const top = facets.slice(0, 12)
// Use: const top = facets.slice(0, CORPUS_FACET_TOP_N)

// ❌ Status labels in a component, not the schema
const STATUS_LABELS = { queued: "En attente", ... }
// These belong in models/ingest/schema.ts (the codes) +
// messages/fr.json (the labels) — never as a Record inside a component

// ❌ Inline IIIF URL
const url = `https://gallica.bnf.fr/${ark}/f${folio}/full/full/0/native.jpg`
// Use: IIIF_IMAGE_URL(ark, folio)
```

## Scope

This rule covers everything under `app/`, `components/`, `lib/`, `models/`,
`hooks/`. It does not apply to generated migration files in `prisma/migrations/`
or test fixtures.
