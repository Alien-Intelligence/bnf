# Page / Client Split Rule

## Rule

Every interactive route has exactly two files:

```
app/[locale]/(workspace)/projects/[projectId]/constituer/
├── page.tsx      ← server component: data loading only
└── client.tsx    ← client component: layout and interactivity
```

No other naming is acceptable. Not `constituer-view.tsx`, not
`constituer-chat-client.tsx`. Always `page.tsx` and `client.tsx`.

## Responsibilities

### `page.tsx` — Server Component
- Never has `"use client"`.
- Fetches all initial data: corpus state, sessions, memory, notes via server
  queries (`models/<name>/queries.ts`, see [models.md](models.md)).
- Resolves auth, project membership, the head and ingested corpus versions.
- Passes fetched data to `<FeatureClient>` as `initial*` props.
- Contains no JSX beyond the client component and server-only wrappers
  (`generateMetadata`, suspense boundaries).

```tsx
// app/[locale]/(workspace)/projects/[projectId]/constituer/page.tsx
import { getCorpusSnapshot } from "@/models/corpus/queries"
import { getSessions } from "@/models/sessions/queries"
import { getMemory } from "@/models/memory/queries"
import { requireProjectMember } from "@/lib/auth-helpers"
import { ConstituerClient } from "./client"

export default async function ConstituerPage({
  params,
}: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const user = await requireProjectMember(projectId)
  const [corpus, sessions, memory] = await Promise.all([
    getCorpusSnapshot(projectId, "head"),
    getSessions(projectId, "corpus"),
    getMemory(projectId, "corpus"),
  ])
  return (
    <ConstituerClient
      projectId={projectId}
      initialCorpus={corpus}
      initialSessions={sessions}
      initialMemory={memory}
    />
  )
}
```

### `client.tsx` — Client Component
- Always starts with `"use client"`.
- Receives `initial*` props — never fetches on mount for data the server already
  has. Seeds the TanStack Query cache via `initialData` (see [hooks.md](hooks.md)).
- Owns all interactivity: state, event handlers, dialogs, the SSE stream
  consumer.
- Renders the page layout using named components from `components/`.

```tsx
// app/[locale]/(workspace)/projects/[projectId]/constituer/client.tsx
"use client"

import { useCorpus } from "@/hooks/api/corpus"
import { CardCorpusSummary } from "@/components/cards/corpus/summary"
import { SheetCorpusChat } from "@/components/sheets/corpus/chat"
import { DialogCorpusIntro } from "@/components/dialogs/corpus/intro"

type ConstituerClientProps = {
  projectId: string
  initialCorpus: CorpusSnapshot
  initialSessions: Session[]
  initialMemory: MemorySnapshot
}

export function ConstituerClient({
  projectId, initialCorpus, initialSessions, initialMemory,
}: ConstituerClientProps) {
  const { data: corpus } = useCorpus(projectId, { initialData: initialCorpus })
  const [introOpen, setIntroOpen] = useState(false)

  return (
    <div className="grid grid-cols-[40%_60%] gap-4 p-6 h-screen">
      <SheetCorpusChat projectId={projectId} sessions={initialSessions} />
      <div className="flex flex-col gap-4 overflow-auto">
        <CardCorpusSummary corpus={corpus} />
        <CardCorpusFiltersDrawer corpus={corpus} />
        <LayoutCorpusDocumentList corpus={corpus} />
      </div>
      <DialogCorpusIntro open={introOpen} onOpenChange={setIntroOpen} />
    </div>
  )
}
```

## Naming the client export

The export name is the route feature in PascalCase + `Client`:

| Route | Client export |
|---|---|
| `projects/[id]/constituer/` | `ConstituerClient` |
| `projects/[id]/ingerer/` | `IngererClient` |
| `projects/[id]/rechercher/` | `RechercherClient` |
| `projects/[id]/rechercher/carnet/` | `CarnetClient` |
| `projects/[id]/sessions/[sid]/` | `SessionClient` |

## Props convention

Server-fetched data passed to the client is always prefixed with `initial`:

```tsx
type RechercherClientProps = {
  projectId: string
  initialCorpusIngestedVersion: number      // 0 if never ingested
  initialNotes: Note[]
  initialSessions: Session[]
  initialMemory: MemorySnapshot
}
```

The client may refetch or mutate this data after mount — but it starts from
`initial*` to prevent layout shift. See the cache seeding pattern in [hooks.md](hooks.md).

## What this forbids

```tsx
// ❌ Arbitrary client file names
projects/[id]/constituer/constituer-view.tsx
projects/[id]/rechercher/research-chat-client.tsx

// ❌ Data fetching inside the client component (it should have come from page.tsx)
export function ConstituerClient({ projectId }: { projectId: string }) {
  const [corpus, setCorpus] = useState<CorpusSnapshot | null>(null)
  useEffect(() => {
    fetch(`/api/projects/${projectId}/corpus`).then(r => r.json()).then(setCorpus)
  }, [projectId])
  // ← server already has this data; don't throw it away
}

// ❌ Business logic in page.tsx
export default async function ConstituerPage({ params }) {
  const corpus = await getCorpusSnapshot(...)
  return (
    <div className="grid grid-cols-[40%_60%] p-6">   {/* ← layout belongs in client */}
      {corpus.documents.map(d => <div>...</div>)}
    </div>
  )
}
```

## Static pages

If a page has zero interactivity (a generated "Carnet" Markdown export rendered
to HTML, an OpenAPI page), `client.tsx` is omitted and `page.tsx` renders the
full output as a server component. This is the exception — every step page in
the BnF workspace needs a client.

## Relation to other rules

- The client follows [page-structure.md](page-structure.md): `div` for layout,
  named components for content.
- Named components follow [componentization.md](componentization.md):
  `components/<type>/<feature>/<name>.tsx`.
- Forms in dialogs follow [forms.md](forms.md): `components/forms/<feature>/<name>.tsx`.
- Streaming session pages add an SSE consumer in the client — see
  [agent-streaming.md](agent-streaming.md).
