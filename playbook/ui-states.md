# UI States Rule

## Rule

Every component that receives async data must handle three states explicitly:
**loading**, **empty**, and **error**. No exceptions. Each state is a distinct
JSX branch — not a ternary chain that collapses two states into one and
silently drops the third.

This matters more in BnF than in most apps because:
- Corpus state can legitimately be empty (a fresh project) — the empty state
  must be *visibly* empty with a CTA, not blank.
- Catalogue/MCP calls can fail upstream — a swallowed `bnf.search` failure
  shows the librarian "no results" when the truth is "the BnF service is down".
- Ingestion jobs run for hours — a stuck "loading…" with no progress is
  indistinguishable from a hung job.

## The three states

### Loading — `Skeleton`

Skeletons mirror the shape of the content they replace. A list of document
cards gets skeleton cards. The facet chart gets a skeleton bar layout. The
skeleton should look like the content at rest, just grey.

```tsx
import { Skeleton } from "@/components/ui/skeleton"

function CardDocumentSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <Skeleton className="h-5 w-1/3" />     {/* title */}
      <Skeleton className="h-4 w-2/3" />     {/* author + year */}
      <Skeleton className="h-3 w-full" />    {/* excerpt */}
      <Skeleton className="h-3 w-5/6" />
    </div>
  )
}
```

No spinners in content areas. No "Loading…" text where content will appear.

### Empty — meaningful, with a CTA

Never render nothing. A bare `null` or empty `<div />` is not an empty state.

```tsx
function CorpusEmpty({ onOpenChat }: { onOpenChat: () => void }) {
  const t = useTranslations("corpus.empty")
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
      <BookOpen className="h-8 w-8" />
      <p className="text-sm">{t("noDocuments")}</p>
      <p className="text-xs">{t("askAgentHint")}</p>
      <Button size="sm" onClick={onOpenChat}>
        <MessageSquare className="mr-2 h-4 w-4" />
        {t("openChat")}
      </Button>
    </div>
  )
}
```

BnF-specific empties:

| Surface | Empty message |
|---|---|
| Corpus document list (fresh project) | "Aucun document. Demandez à l'agent de constituer un corpus." |
| Notes / Carnet | "Aucune note. Posez une question à l'agent pour démarrer." |
| Sessions list | "Aucune session pour l'instant." |
| `rag.query` returns 0 passages | Not an empty state — the agent must *say so* in chat ("Aucun passage pertinent trouvé"); see [agent-streaming.md](agent-streaming.md) |

### Error — visible, retriable, never silent

```tsx
function CorpusError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("common")
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-destructive">
      <AlertCircle className="h-6 w-6" />
      <p className="text-sm">{t("error")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("tryAgain")}
      </Button>
    </div>
  )
}
```

Never silently swallow an error into an empty list — the user cannot tell
whether no data exists or something broke. See
[client-patterns.md](client-patterns.md) for how errors must throw out of
fetchers so this state can be reached.

## Pattern: TanStack Query

```tsx
import { useCorpus } from "@/hooks/api/corpus"

export function LayoutCorpusDocumentList({ projectId }: Props) {
  const { data, isLoading, isError, refetch } = useCorpus(projectId)

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => <CardDocumentSkeleton key={i} />)}
      </div>
    )
  }
  if (isError) return <CorpusError onRetry={refetch} />
  if (!data || data.total === 0) return <CorpusEmpty onOpenChat={...} />

  return (
    <ul className="flex flex-col gap-4">
      {data.sample.map(doc => <CardDocumentRow key={doc.ark} doc={doc} />)}
    </ul>
  )
}
```

Order is fixed: **loading → error → empty → content**. Write them as explicit
`if` blocks, not a ternary pyramid.

## Streaming agent turns have their own states

The chat surface is not a list of static items — it's a streaming SSE
conversation. The three states map differently:

| Static state | Streaming equivalent |
|---|---|
| Loading | Agent is *thinking* (tool-call chip visible, no token yet) |
| Empty | Session has no messages yet (welcome card + suggested prompts) |
| Error | Stream errored mid-turn (toast + retry button on the failed turn) |

See [agent-streaming.md](agent-streaming.md) for the full event model.

## Ingestion has its own progress UI

Step 2 has a four-stage pipeline (`extract → chunk → embed → index`) with
per-stage fractions. This is *not* the generic loading state. The stage card
component (`CardIngestStagePipeline`) renders all four stages always — pending,
running, done — never "loading…" or "empty". See
[ingestion-jobs.md](ingestion-jobs.md).

## Anti-patterns (FORBIDDEN)

```tsx
// ❌ No loading state — empty UI while data loads
{data && data.documents.map(d => <CardDocumentRow key={d.ark} doc={d} />)}

// ❌ Spinner in a content area — layout jumps when content arrives
{isLoading ? <Loader2 className="animate-spin" /> : <DocumentList />}

// ❌ Error silently rendered as empty list
.catch(() => setDocuments([]))

// ❌ Ternary chain that collapses error and empty
{isLoading ? <Skeleton /> : data?.total ? <List /> : <Empty />}
// (error is swallowed; user sees "empty" when the corpus fetch failed)

// ❌ Rendering nothing for the empty state
if (data.total === 0) return null
```

## Scope

Applies to every component that loads async data:

- TanStack Query hooks (`useQuery`)
- SSE stream consumers (the chat surface and the ingest progress surface)
- Server-component pages — though pages always seed with `initial*` props, so
  they should not hit the loading state; the client hook reads from
  `initialData` and goes straight to content.
