# Data Fetching Rule

## Rule

All data flows through two dedicated layers: server queries in
`models/<model>/queries.ts` and TanStack Query hooks in `hooks/api/<model>.ts`.
No client component fetches data any other way.

The exception is the agent SSE stream, which uses a dedicated `EventSource`
consumer hook documented in [agent-streaming.md](agent-streaming.md). It is
still in `hooks/api/`, but it isn't a `useQuery`.

## `models/<model>/queries.ts` — server-only

See [models.md](models.md) for the full file structure. Briefly:

- `import "server-only"` is the first line.
- Functions are `async`, explicitly typed, receive only the args they need.
- `page.tsx` calls these — never Drizzle/Prisma inline.
- Named after the operation: `getCorpusSnapshot`, `getSessions`, `getNote`,
  `getMemory`, `insertNote`, `updateNote`, `deleteNote`.

```ts
// models/corpus/queries.ts
import "server-only"
import { prisma } from "@/lib/db"
import { corpusSnapshot, type CorpusSnapshot } from "./schema"

export async function getCorpusSnapshot(
  projectId: string,
  versionRef: "head" | "ingested" | { seq: number },
): Promise<CorpusSnapshot> {
  // ... resolve version_id, fetch membership + facets ...
}
```

## `hooks/api/<model>.ts` — TanStack Query hooks

```
hooks/api/corpus.ts
hooks/api/sessions.ts
hooks/api/messages.ts
hooks/api/notes.ts
hooks/api/memory.ts
hooks/api/ingest.ts
hooks/api/projects.ts
hooks/api/documents.ts
```

- Every file is a client module — `"use client"` is required.
- `useQuery` for reads, `useMutation` for writes.
- Query keys defined once at the top as a `const` object — never inlined at
  the call site.
- Every mutation's `onSuccess` calls `queryClient.invalidateQueries` on the
  relevant key(s).
- Response types come from `@/models/<model>/types.ts` or `schema.ts` via
  `z.infer` / Prisma `GetPayload` — never typed by hand.
- All HTTP calls go through `apiFetch` from `@/lib/api-fetch.ts` — never raw
  `fetch()`.

### Complete example — `hooks/api/corpus.ts`

```ts
"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { CorpusSnapshot } from "@/models/corpus/schema"
import type {
  CorpusAddInput, CorpusRemoveInput, CorpusDiff,
} from "@/models/corpus/types"

// ── Query keys ──────────────────────────────────────────────────────────────

export const corpusKeys = {
  all: (projectId: string) => ["corpus", projectId] as const,
  snapshot: (projectId: string, version: "head" | "ingested" | number) =>
    ["corpus", projectId, "snapshot", version] as const,
  diff: (projectId: string, from: number, to: number) =>
    ["corpus", projectId, "diff", from, to] as const,
}

// ── Read hooks ──────────────────────────────────────────────────────────────

export function useCorpus(
  projectId: string,
  opts: { initialData?: CorpusSnapshot; version?: "head" | "ingested" | number } = {},
) {
  const version = opts.version ?? "head"
  return useQuery<CorpusSnapshot>({
    queryKey: corpusKeys.snapshot(projectId, version),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus?version=${version}`)
      if (!res.ok) throw new Error("Failed to fetch corpus")
      return res.json()
    },
    initialData: opts.initialData,
  })
}

export function useCorpusDiff(projectId: string, from: number, to: number) {
  return useQuery<CorpusDiff>({
    queryKey: corpusKeys.diff(projectId, from, to),
    queryFn: async () => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus/diff?from=${from}&to=${to}`)
      if (!res.ok) throw new Error("Failed to fetch corpus diff")
      return res.json()
    },
    enabled: Number.isFinite(from) && Number.isFinite(to),
  })
}

// ── Write hooks ─────────────────────────────────────────────────────────────

export function useAddToCorpus(projectId: string) {
  const qc = useQueryClient()
  return useMutation<CorpusSnapshot, Error, CorpusAddInput>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/corpus/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to add to corpus")
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) }),
  })
}
```

### Naming convention

| Operation | Hook |
|---|---|
| Read current corpus snapshot | `useCorpus(projectId)` |
| Read a session's messages | `useMessages(sessionId)` |
| Read a single note | `useNote(noteId)` |
| List sessions for a scope | `useSessions(projectId, scope)` |
| Add docs to corpus | `useAddToCorpus(projectId)` |
| Remove docs from corpus | `useRemoveFromCorpus(projectId)` |
| Create note | `useCreateNote(projectId)` |
| Update note | `useUpdateNote(noteId)` |
| Delete note | `useDeleteNote()` |
| Submit ingest job | `useSubmitIngest(projectId)` |
| Poll ingest status | `useIngestStatus(jobId)` (see below) |

## Polling — ingest status

Ingestion is long-running. The status hook uses TanStack's `refetchInterval`
plus a stop condition.

```ts
export function useIngestStatus(jobId: string | null) {
  return useQuery<IngestJob>({
    queryKey: ["ingest", jobId],
    queryFn: async () => {
      const res = await apiFetch(`/api/ingest/${jobId}`)
      if (!res.ok) throw new Error("Failed to fetch ingest status")
      return res.json()
    },
    enabled: !!jobId,
    refetchInterval: (q) =>
      q.state.data?.status === "running" || q.state.data?.status === "queued"
        ? INGEST_POLL_INTERVAL_MS
        : false,
  })
}
```

`INGEST_POLL_INTERVAL_MS` lives in `lib/constants.ts` (see
[constants.md](constants.md)) — never inline a number like `2000`. For very
long jobs prefer SSE; see [ingestion-jobs.md](ingestion-jobs.md).

## SSE streams — not `useQuery`

The agent turn stream is consumed by a dedicated hook
`useAgentStream(sessionId)` that owns its own `EventSource` lifecycle and
exposes the live state (tokens, tool-call chips, corpus events). It writes
into the TanStack cache via `queryClient.setQueryData` so the rest of the UI
re-renders. See [agent-streaming.md](agent-streaming.md).

## Rule: no inline data fetching in client components

```tsx
// ✅ Correct
"use client"
import { useCorpus } from "@/hooks/api/corpus"
export function ConstituerClient({ projectId, initialCorpus }) {
  const { data: corpus } = useCorpus(projectId, { initialData: initialCorpus })
}

// ❌ useEffect + fetch — no key, no cache, no dedup
useEffect(() => {
  fetch(`/api/projects/${projectId}/corpus`).then(r => r.json()).then(setCorpus)
}, [projectId])

// ❌ useState for server data — bypasses the cache entirely
const [corpus, setCorpus] = useState<CorpusSnapshot | null>(null)

// ❌ apiFetch inside a component body — runs on every render
const res = await apiFetch(`/api/projects/${projectId}/corpus`)
```

The `initial*` props from `page.tsx` seed the TanStack cache via
`initialData` — they do not replace the hook.

## Relation to other rules

- Server queries are called by `page.tsx` per [page-client-split.md](page-client-split.md).
- Mutation hooks invalidate query keys so lists and detail views stay in sync.
- The `apiFetch` wrapper is mandatory — Next.js `basePath` is not applied to
  raw `fetch()` from the browser.
- `res.ok` is checked before `.json()` in every `queryFn`/`mutationFn` —
  see [client-patterns.md](client-patterns.md).
