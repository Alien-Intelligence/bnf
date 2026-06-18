# Client Patterns Rule

## Rule

Five recurring client-side patterns each have one correct form. Deviating
from any of them produces silent failures indistinguishable from empty states
or successful no-ops.

---

## 1. Always check `res.ok` before parsing API responses

Without a `res.ok` check, a 401 or 500 body is passed to `.json()` and
parsed as data. An `{ error: "Unauthorized" }` object is not an array — the
error state from [ui-states.md](ui-states.md) never renders; the user sees
an empty list.

**Forbidden:**
```ts
const res = await apiFetch(`/api/projects/${projectId}/corpus`)
const data = await res.json()
setCorpus(Array.isArray(data.sample) ? data : EMPTY_CORPUS)  // silent
```

**Correct:**
```ts
const res = await apiFetch(`/api/projects/${projectId}/corpus`)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
return res.json() as Promise<CorpusSnapshot>
```

The check goes **immediately after** the `apiFetch` call, **before** `.json()`
and any state assignment. Every `apiFetch` call requires it.

Errors must surface to the user — toast and/or the error state. Never catch
and swallow.

---

## 2. Never use `onOpenChange` to trigger data fetching in controlled dialogs

Radix `onOpenChange` fires only for **user-initiated** transitions. When a
parent programmatically opens a dialog by setting `open={true}`, `onOpenChange`
is **not** called with `true`. Any data fetch in `onOpenChange` silently never
runs on programmatic open.

**Forbidden:**
```ts
async function handleOpenChange(next: boolean) {
  onOpenChange(next)
  if (next && !loaded) {
    const data = await apiFetch("/api/projects/.../memory")
    setMemory(await data.json())
  }
}
<Dialog open={open} onOpenChange={handleOpenChange}>
```

**Correct:**
```ts
useEffect(() => {
  if (!open) {
    setSelection(null)
    return
  }
  load().catch(() => toast.error(t("failedLoadMemory")))
}, [open])

<Dialog open={open} onOpenChange={onOpenChange}>
```

`useEffect([open])` owns all data loading and reset logic.
`onOpenChange` only propagates close events back to the parent.

This bites the BnF app hardest in the **memory dialog** and the **citation
side panel** (both can be opened programmatically: by the agent emitting a
`memory_event`, or by the user clicking an ARK pill in chat).

---

## 3. Never wrap server-passed props in `useState` when using `router.refresh()`

When a client component wraps a server-passed prop in `useState`, React
initialises state **once on mount** and ignores subsequent prop updates —
including those triggered by `router.refresh()`. The server re-fetches and
passes fresh data, but the component never sees it.

**Forbidden:**
```tsx
export function ConstituerClient({ initialCorpus }: { initialCorpus: CorpusSnapshot }) {
  const [corpus] = useState(initialCorpus) // ← frozen after first render
  return <LayoutCorpusDocumentList corpus={corpus} />
}
```

**Correct — no local mutations needed:**
```tsx
export function ConstituerClient({ initialCorpus }: { initialCorpus: CorpusSnapshot }) {
  const { data: corpus } = useCorpus(projectId, { initialData: initialCorpus })
  return <LayoutCorpusDocumentList corpus={corpus} />
}
```

**Correct — when keeping local state in sync:**
```tsx
const [corpus, setCorpus] = useState(initialCorpus)
useEffect(() => { setCorpus(initialCorpus) }, [initialCorpus])
```

**Decision rule:**
- No local mutations → drop `useState`, use the prop directly (or `useCorpus`
  with `initialData`).
- Optimistic updates needed → keep `useState` + `useEffect([initialProp])` to
  resync after server refresh.

Where `router.refresh()` fires in the BnF app:
- After creating a project (redirects to project page, refresh on entry).
- After deleting a note from the Carnet view.
- After a corpus mutation that the SSE stream did not surface (a rare
  agent fallback path).

---

## 4. Preserve client-side enriched fields on mutation update

When a mutation response replaces a record in local state, any field added
client-side (not returned by the API) is silently lost.

Common BnF client-side fields:
- `isOwn` — computed at fetch time from project membership.
- `iiifUrl` — derived from ARK + folio in the client.
- `selected` — UI state on a document in the corpus list.

**Forbidden:**
```ts
setDocs(prev => prev.map(d => d.ark === updated.ark ? updated : d))
// updated lacks iiifUrl / selected; they vanish silently
```

**Correct:**
```ts
setDocs(prev => prev.map(d =>
  d.ark === updated.ark ? { ...updated, iiifUrl: d.iiifUrl, selected: d.selected } : d
))
```

When the component uses TanStack mutations with `invalidateQueries`, the
re-fetch re-derives client-side fields in the `queryFn` — this rule then
applies only to legacy components that haven't migrated.

---

## 5. URL is the source of truth for sharable view state

Active facet filters, the selected document ARK, the open session ID — any
state that should survive a refresh and be linkable — lives in the URL as
search params, not in `useState`.

```tsx
// app/[locale]/(workspace)/projects/[id]/constituer/client.tsx
import { useSearchParams, useRouter, usePathname } from "next/navigation"

export function ConstituerClient(...) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const activeLang = params.get("lang")    // e.g. "fr"
  const activeArk = params.get("ark")      // for the doc-detail Sheet

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    value ? next.set(key, value) : next.delete(key)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }
  // ...
}
```

What goes in state vs URL:

| In URL (`useSearchParams`) | In React state (`useState`) |
|---|---|
| Active facet filters | The text typed into the live filter input (debounced into URL) |
| Selected doc ARK (opens `SheetDocumentDetail`) | Hover-states, focus rings |
| Open citation (ARK + folio) | The token stream of an in-flight agent turn |
| Current session id | The form-field values during editing |

**Forbidden:**
```tsx
// ❌ Filter state in useState — refresh loses it, can't share a link
const [activeLang, setActiveLang] = useState<string | null>(null)
```

---

## Anti-patterns summary

```ts
// ❌ Array guard masks an HTTP error as empty state
const data = await res.json()
setDocs(Array.isArray(data) ? data : [])

// ❌ res.ok checked after .json() — too late, body already parsed
const data = await res.json(); if (!res.ok) throw …

// ❌ Data fetch inside onOpenChange — silently skipped on programmatic open
async function handleOpenChange(next) { if (next) await load() }

// ❌ useState freezes prop — router.refresh() updates ignored
const [corpus] = useState(initialCorpus)

// ❌ Bare API response replaces local record — client-side fields lost
setDocs(prev => prev.map(d => d.ark === u.ark ? u : d))

// ❌ Active facet stored in useState — refresh wipes the view
const [lang, setLang] = useState<string | null>(null)
```

## Relation to other rules

- [ui-states.md](ui-states.md): rules 1 and 4 produce the same visible
  symptom — an API failure rendered as an empty state. `ui-states.md` defines
  what the error state must look like; this file defines how errors must
  surface so that state can be reached.
- [hooks.md](hooks.md): TanStack Query hooks handle `res.ok` and throw by
  convention; `onSuccess` + `invalidateQueries` re-fetches so client-side
  fields are re-derived in the `queryFn` rather than preserved manually.
  Rules 1 and 4 mainly apply to legacy `useState` + `useEffect` components.
- [agent-streaming.md](agent-streaming.md): the SSE consumer hook follows
  the same "throw on error, never swallow" discipline as `apiFetch`.
