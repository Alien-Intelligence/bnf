# Domain Model Rule

## Rule

Every domain model lives in its own directory under `models/` at the project
root. Each directory contains exactly five files — no more, no fewer. Nothing
about a domain is scattered across the codebase.

## Directory structure

```
models/
  projects/      schema.ts  queries.ts  service.ts  policy.ts  types.ts
  corpus/        schema.ts  queries.ts  service.ts  policy.ts  types.ts
  documents/     schema.ts  queries.ts  service.ts  policy.ts  types.ts
  sessions/      schema.ts  queries.ts  service.ts  policy.ts  types.ts
  messages/      schema.ts  queries.ts  service.ts  policy.ts  types.ts
  memory/        schema.ts  queries.ts  service.ts  policy.ts  types.ts
  notes/         schema.ts  queries.ts  service.ts  policy.ts  types.ts
  ingest/        schema.ts  queries.ts  service.ts  policy.ts  types.ts
  users/         schema.ts  queries.ts  service.ts  policy.ts  types.ts
```

One directory per domain. Five files per directory. No sixth file, no
subdirectories.

The model boundary follows [doc 03](../design/docs/03-data-model.md) — one
folder per top-level entity. `corpus_version` and `corpus_membership` belong
to `corpus/` (versioning is part of the corpus model). `tool_call` belongs to
`messages/` (it's a structured log under a message). `citation` belongs to
`notes/` (a derived projection of note bodies).

## File responsibilities

### `schema.ts` — table definitions, query shapes, domain constants

Prisma model in `prisma/schema.prisma` is the source of truth for tables; this
file holds named query shapes (`satisfies Prisma.XxxDefaultArgs`), their
derived types via `Prisma.XxxGetPayload`, and domain enums (`SESSION_SCOPE`,
`INGEST_STATUS`, `MEMORY_SCOPE`, `CORPUS_VERSION_STATUS`).

```ts
// models/corpus/schema.ts
import { Prisma } from "@/lib/generated/prisma/client"

export const CORPUS_VERSION_STATUS = {
  DRAFT: "draft",
  SEALED: "sealed",
  INGESTED: "ingested",
  FAILED: "failed",
} as const
export type CorpusVersionStatus =
  (typeof CORPUS_VERSION_STATUS)[keyof typeof CORPUS_VERSION_STATUS]

// Query shape: a corpus version with its membership ARKs only (no Document join)
export const corpusVersionWithArks = {
  include: { membership: { select: { ark: true } } },
} satisfies Prisma.CorpusVersionDefaultArgs
export type CorpusVersionWithArks =
  Prisma.CorpusVersionGetPayload<typeof corpusVersionWithArks>

// The shape returned to the client for the comprehension panel
export type CorpusSnapshot = {
  versionSeq: number
  versionStatus: CorpusVersionStatus
  total: number
  facets: { type: Record<string, number>; lang: Record<string, number>;
            source: Record<string, number>; period: Record<string, number> }
  sample: DocumentRow[]
}

export const documentRow = {
  select: {
    ark: true, title: true, author: true, year: true,
    docType: true, lang: true, source: true, pages: true,
    excerpt: true, iiifManifestUrl: true,
  },
} satisfies Prisma.DocumentDefaultArgs
export type DocumentRow = Prisma.DocumentGetPayload<typeof documentRow>
```

Rules:
- No imports from other model directories — `schema.ts` is the foundation.
- No imports from `app/`, `components/`, `hooks/`, `lib/mcp/`, `lib/cluster/`.
- Enums are plain `const` objects with a companion type, not `enum` keyword.
- Domain enums (status, scope, role) belong here, not in `app/api/` or
  `components/`.

### `queries.ts` — server-only database access

Pure database access. No business logic, no external calls, no transforms
beyond what Prisma returns.

```ts
// models/corpus/queries.ts
import "server-only"
import { prisma } from "@/lib/db"
import { corpusVersionWithArks, documentRow, type CorpusSnapshot } from "./schema"

export class CorpusQueries {
  static async headVersion(projectId: string) {
    return prisma.corpusVersion.findFirstOrThrow({
      where: { projectId, isHead: true },
      ...corpusVersionWithArks,
    })
  }

  static async ingestedVersion(projectId: string) {
    return prisma.corpusVersion.findFirst({
      where: { projectId, status: "ingested" },
      orderBy: { seq: "desc" },
      ...corpusVersionWithArks,
    })
  }

  static async membershipArks(versionId: string): Promise<string[]> {
    const rows = await prisma.corpusMembership.findMany({
      where: { versionId },
      select: { ark: true },
    })
    return rows.map(r => r.ark)
  }

  static async snapshot(
    projectId: string,
    versionRef: "head" | "ingested" | { seq: number },
  ): Promise<CorpusSnapshot> { /* ... */ }
}
```

Rules:
- `import "server-only"` is the first line, always.
- Returns Prisma-derived types directly via `GetPayload` (see
  [prisma-shapes](../design/docs/README.md) — same convention as the
  alien-agents `prisma-shapes` rule).
- Imports only from `@/lib/db` and `./schema`.
- Queries from *other* models may be imported in `service.ts` — never in
  `queries.ts`.

### `service.ts` — business logic

Orchestrates queries, MCP calls, cluster calls. This is where the logic that
belongs to neither the route handler nor the database lives. See
[api-layers.md](api-layers.md) for the full pattern.

Rules:
- Server-only; never imported by client components.
- Throws typed errors — not `Response` objects.
- May import: queries from this model and from other models, the MCP client
  from `lib/mcp/`, the cluster client from `lib/cluster/`.
- No imports from `app/` or `components/`.
- Receives a *verified* user — auth is the route handler's job.

### `policy.ts` — authorization rules

Single exported class encapsulating every authorization decision for the
model. See [api-layers.md](api-layers.md) for the full pattern.

Rules:
- One class per file: `[Model]Policy`.
- `before()` is the admin bypass.
- Action methods return `boolean` (or `Promise<boolean>` only when genuinely
  needed — rare).
- No DB calls inside policy methods — resources are passed in.
- Imports only `./schema` for types.

### `types.ts` — Zod schemas and request/response inputs

Zod schemas for request validation and their inferred TypeScript types. These
are what route handlers validate against and what hooks import.

```ts
// models/corpus/types.ts
import { z } from "zod"

export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "invalid ARK")

export const addToCorpusSchema = z.object({
  arks: z.array(arkSchema).min(1).max(5_000),
  reason: z.string().trim().min(1).max(300),
})
export type AddToCorpusInput = z.infer<typeof addToCorpusSchema>

export const removeFromCorpusSchema = z.object({
  arks: z.array(arkSchema).min(1).max(5_000).optional(),
  where: z.object({
    lang: z.object({ neq: z.string() }).optional(),
    docType: z.object({ in: z.array(z.string()) }).optional(),
  }).optional(),
  reason: z.string().trim().min(1).max(300),
}).refine(v => !!v.arks || !!v.where, "must provide arks or where")
export type RemoveFromCorpusInput = z.infer<typeof removeFromCorpusSchema>

export type CorpusDiff = {
  fromSeq: number
  toSeq: number
  added: string[]   // ARKs
  removed: string[] // ARKs
  addedCount: number
  removedCount: number
}
```

Rules:
- Export both the Zod schema and the inferred type; the type name is the
  schema name without the `Schema` suffix (`addToCorpusSchema` →
  `AddToCorpusInput`).
- No imports from `app/`, `components/`, or `lib/mcp|cluster/`.
- DB-derived shapes (`CorpusSnapshot`, `DocumentRow`, `NoteWithCitations`) live
  in `schema.ts`, not here.

## Import diagram

```
types.ts      ← zod (no internal imports)
schema.ts     ← @/lib/generated/prisma/client (no internal imports)
queries.ts    ← @/lib/db, ./schema
policy.ts     ← ./schema (types only)
service.ts    ← ./queries, ./types, lib/mcp, lib/cluster, other models' queries
─────────────────────────────────────────────────────────────
app/api/      ← ./queries (reads), ./service (writes), ./policy, ./types
hooks/        ← ./types (inputs) + ./schema (response types) — types only
components/   ← ./types (inputs to feed mutation hooks)
```

Arrows are one-directional. Nothing below the line imports from `app/` or
`components/`. Nothing in `queries.ts` or `schema.ts` reaches sideways.

## Cross-model service calls

Some operations span models legitimately:

- `IngestService.submit()` reads `CorpusQueries.headVersion()` to build the
  delta — that's `models/ingest/service.ts` importing
  `models/corpus/queries.ts`. Allowed.
- `MemoryService.write()` is invoked from `AgentService.runTurn()` —
  `models/agents/service.ts` (or wherever the agent loop lives) importing
  `models/memory/service.ts`. Allowed.

What is **not** allowed:

- Mutual imports between two services (`A.service ↔ B.service`). Extract the
  shared logic into a `lib/` helper or restructure.
- A `queries.ts` importing another model's `queries.ts`. If you need a join
  across models, write a single Prisma query in the model that *owns* the
  primary entity.

## Forbidden patterns

```ts
// ❌ Domain enum defined outside models/
// In components/badges/ingest/status.tsx:
const STATUS_LABELS = { queued: "En attente", running: "En cours" }
// → move to models/ingest/schema.ts

// ❌ Query in lib/queries/ (legacy location)
// lib/queries/corpus.ts
// → move to models/corpus/queries.ts

// ❌ Business logic in a route handler
// app/api/projects/[id]/corpus/add/route.ts inlines the MCP resolve loop
// → belongs in models/corpus/service.ts

// ❌ Inline authorization in a route handler
if (project.ownerId !== user.id) return forbidden()
// → belongs in models/corpus/policy.ts

// ❌ Types duplicated between route and hook
// In app/api/.../route.ts:   type CorpusDiff = { ... }
// In hooks/api/corpus.ts:    type CorpusDiff = { ... }
// → define once in models/corpus/types.ts

// ❌ models/ file importing from app/ or components/
import { toast } from "@/components/ui/sonner"   // never
```

## Special model — `agents/`

The corpus agent and the research agent share a single `models/agents/` model
even though they have two distinct prompts and tool sets. Why one folder:

- They share the streaming runtime (Claude conversation, tool dispatcher, SSE
  emitter).
- They share the same persistence model (messages, tool_calls).
- They differ only in the **prompt** (loaded from `lib/prompts/`) and the
  **enabled tool set**, which is configuration, not a separate model.

`AgentService.runTurn(session, user, input)` dispatches based on
`session.scope` (`"corpus" | "research"`). See
[agent-streaming.md](agent-streaming.md).

## Relation to other rules

- Route handlers call `service.ts` for mutations and `queries.ts` for reads —
  never Prisma inline. See [api-routes.md](api-routes.md), [api-layers.md](api-layers.md).
- `parseBody` validates against schemas exported from `types.ts`.
- Response types travel from `models/<model>/schema.ts` → route handler →
  hook with no intermediate redefinition.
