# Page Structure Rule

## Rule

A page file is a layout skeleton. It uses `div` only to establish spacing and
grid structure. All UI content lives in named components built on shadcn
primitives.

A component that would be built from raw `div`s to create visual structure (box,
panel, section, drawer, list item) must instead use the appropriate shadcn
primitive as its base and be extracted following the [componentization rule](componentization.md).

## What a BnF page should look like

```tsx
// app/[locale]/(workspace)/projects/[projectId]/constituer/client.tsx
"use client"

export function ConstituerClient({ initialCorpus, initialSessions }: Props) {
  return (
    <div className="grid grid-cols-[40%_60%] gap-4 p-6 h-screen">
      <SheetCorpusChat projectId={projectId} sessions={initialSessions} />
      <div className="flex flex-col gap-4">
        <CardCorpusSummary corpus={initialCorpus} />
        <CardCorpusFiltersDrawer corpus={initialCorpus} />
        <LayoutCorpusDocumentList corpus={initialCorpus} />
      </div>
      <DialogCorpusIntro />
    </div>
  )
}
```

The page (and its client) has no visual logic. It answers: *"which components
go here and how are they spaced?"* The 40/60 chat/workspace split is
[a fixed UX contract](../design/docs/01-product-overview.md#step-1--constituer-corpus-creation).

## The shadcn primitive → BnF use-case map

When you are about to reach for a `div`, ask which primitive fits:

| You want to build... | Use | BnF example |
|---|---|---|
| A box with header + body (corpus summary, doc detail) | `Card` | `CardCorpusSummary`, `CardDocumentDetail` |
| A side panel (citation drawer, doc inspection) | `Sheet` | `SheetCitationSource`, `SheetDocumentDetail` |
| A modal (onboarding intro, memory editor) | `Dialog` | `DialogCorpusIntro`, `DialogMemoryEdit` |
| A confirmation (destructive corpus remove) | `AlertDialog` | `AlertDialogCorpusBulkRemove` |
| An expandable "Filtres et statistiques" drawer | `Collapsible` or `Accordion` | `CardCorpusFiltersDrawer` |
| Tabbed views (Atelier: chat + note) | `Tabs` | `TabsResearchAtelier` |
| Tool-call chip / citation chip | `Badge` | `BadgeToolCall`, `BadgeArkCitation` |
| Period histogram / facet bar | `Chart` (shadcn) | `ChartCorpusHistogram`, `ChartCorpusFacets` |

If no shadcn primitive fits, `div` is acceptable — but that is the exception.

## The test

> **If the div has a border, shadow, background, rounded corners, or fixed
> positioning — it should be a shadcn primitive.**

The 40/60 grid wrapper is a `div`. The chat panel inside it is not.

## What this forbids

```tsx
// ❌ Raw div panel — this IS a Card
<div className="border rounded-lg p-4">
  <div className="font-semibold">Aperçu du corpus</div>
  <div className="text-muted-foreground">{total} documents</div>
</div>

// ✅ Correct
<CardCorpusSummary corpus={corpus} />

// ❌ Div-based side panel — this IS a Sheet
<div className={cn("fixed inset-y-0 right-0 w-96", citationOpen && "translate-x-0")}>
  <h3>{citation.label}</h3>
  <a href={iiifUrl}>Voir le folio</a>
</div>

// ✅ Correct
<SheetCitationSource open={open} citation={citation} onOpenChange={...} />

// ❌ Stats tile built from raw divs
<div className="rounded-xl border p-4 shadow-sm">
  <div className="text-3xl">{corpus.total}</div>
  <div className="text-sm text-muted">documents</div>
</div>

// ✅ Correct — extract as a Card
<CardCorpusSummaryTile label={t("total")} value={corpus.total} />
```

## Inside a shadcn primitive: use its sub-components

```tsx
// ❌ Raw divs inside a Card
<Card>
  <div className="font-semibold p-4">Le Figaro</div>
  <div className="p-4">{excerpt}</div>
</Card>

// ✅ Use the primitive's anatomy
<Card>
  <CardHeader>
    <CardTitle>Le Figaro</CardTitle>
    <CardDescription>{ark}</CardDescription>
  </CardHeader>
  <CardContent>{excerpt}</CardContent>
  <CardFooter>
    <Button variant="link" asChild><a href={gallicaUrl}>{t("openOnBnf")}</a></Button>
  </CardFooter>
</Card>
```

| Primitive | Sub-components |
|---|---|
| `Card` | `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` |
| `Dialog` | `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogContent`, `DialogFooter` |
| `Sheet` | `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetContent`, `SheetFooter` |
| `Tabs` | `TabsList`, `TabsTrigger`, `TabsContent` |
| `Accordion` | `AccordionItem`, `AccordionTrigger`, `AccordionContent` |

## The two-layer rule

Every non-trivial page decomposes into exactly two layers:

**Layer 1 — Page (`client.tsx`)**: layout only (`div` + spacing/grid classes).
No visual chrome. No business logic.

**Layer 2 — Components**: shadcn-based named components that own their visual
structure. No raw layout divs at the top level of their return — only the
shadcn primitive.

```
Constituer page
 └─ div (40/60 grid)
     ├─ SheetCorpusChat              ← Sheet
     ├─ div (vertical stack)
     │   ├─ CardCorpusSummary        ← Card
     │   ├─ CardCorpusFiltersDrawer  ← Collapsible
     │   └─ LayoutCorpusDocumentList ← layout (ul, not a card)
     └─ DialogCorpusIntro            ← Dialog (conditionally rendered)
```

## div is still valid for

- Flex / grid containers for spacing: `<div className="flex gap-4">`
- The 40/60 chat-workspace split itself: `<div className="grid grid-cols-[40%_60%]">`
- Page-level padding / max-width: `<div className="max-w-6xl mx-auto px-6">`
- Inline layout within a component (icon + label inside a `Card`)

## Project shell ✅

Every step of a project (Constituer, Ingérer, Rechercher, Carnet) shares one
header, mounted once by `app/[locale]/projects/[projectId]/layout.tsx`.

- The layout owns `LayoutWorkspaceHeader`. Step clients never mount it: their
  root fills the layout's `min-h-0 flex-1` slot (a fragment or a
  `flex min-h-0 flex-1 …` div), never `h-screen`.
- The layout fetches the header's data but **never gates**. A layout does not
  re-render on navigation and cannot read the pathname (Next 16 authentication
  guide, "Layouts and auth checks"; `layout.md` "Pathname"), so it can neither
  keep a session check fresh nor build the right `?next=`. Pages keep
  `requireSessionUser(<own path>)` and their access checks. With no session,
  or a project the user may not read, the layout renders `children` bare: the
  page redirects or answers `notFound()`, and a 404 never shows a project name.
- Header permissions (`steps`, `mayShare`) come from
  `lib/authz/workspace-header.ts`, which delegates to the predicates the routes
  enforce (`workspaceStepsFor`, `ProjectPolicy.share`). Never recompute them in
  a component.

```tsx
// ❌ A step client mounting its own header, with hand-assembled props
<div className="flex h-screen flex-col">
  <LayoutWorkspaceHeader user={…} isAdmin={…} project={…} />
  <div className="flex flex-1 overflow-hidden">…</div>
</div>

// ✅ The step client fills the layout's slot
<div className="flex min-h-0 flex-1 overflow-hidden">…</div>
```
