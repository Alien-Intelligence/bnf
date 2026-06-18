# Component Extraction Rule

## Rule

Every compound UI primitive must be extracted into a dedicated named component
file. No raw `<Dialog>`, `<Card>`, `<Sheet>`, `<AlertDialog>`, `<Drawer>`,
`<Popover>`, `<DropdownMenu>`, `<Select>`, `<Tooltip>`, `<HoverCard>`, `<Tabs>`,
`<Accordion>`, or `<Collapsible>` tags may appear inline in page files or other
feature components.

## File structure

```
components/<type>/<feature>/<name>.tsx
```

- **type**: the root UI primitive being wrapped, plural and lowercase
  - `dialogs/`, `cards/`, `sheets/`, `drawers/`, `popovers/`, `dropdowns/`,
    `selects/`, `tooltips/`, `alerts/`, `tabs/`, `accordions/`, `badges/`,
    `charts/`, `layouts/`, `forms/`
- **feature**: the BnF domain area, lowercase kebab-case
  - `corpus/`, `documents/`, `sessions/`, `memory/`, `notes/`, `ingest/`,
    `research/`, `citations/`, `projects/`
- **name**: the specific variant or action, lowercase kebab-case
  - `summary.tsx`, `detail.tsx`, `create.tsx`, `edit.tsx`, `remove-confirm.tsx`,
    `intro.tsx`

## Component naming

PascalCase: **type (singular) + feature (PascalCase) + name (PascalCase)**.

| File path | Component name |
|---|---|
| `components/cards/corpus/summary.tsx` | `CardCorpusSummary` |
| `components/cards/corpus/filters-drawer.tsx` | `CardCorpusFiltersDrawer` |
| `components/cards/documents/detail.tsx` | `CardDocumentDetail` |
| `components/sheets/corpus/chat.tsx` | `SheetCorpusChat` |
| `components/sheets/citations/source.tsx` | `SheetCitationSource` |
| `components/dialogs/corpus/intro.tsx` | `DialogCorpusIntro` |
| `components/dialogs/research/intro.tsx` | `DialogResearchIntro` |
| `components/dialogs/memory/edit.tsx` | `DialogMemoryEdit` |
| `components/alerts/corpus/bulk-remove.tsx` | `AlertDialogCorpusBulkRemove` |
| `components/badges/citations/ark.tsx` | `BadgeArkCitation` |
| `components/badges/tools/call.tsx` | `BadgeToolCall` |
| `components/charts/corpus/histogram.tsx` | `ChartCorpusHistogram` |
| `components/charts/corpus/facets.tsx` | `ChartCorpusFacets` |
| `components/layouts/corpus/document-list.tsx` | `LayoutCorpusDocumentList` |
| `components/tabs/research/atelier.tsx` | `TabsResearchAtelier` |
| `components/forms/projects/create.tsx` | `FormProjectCreate` |

## Usage in pages and parent components

```tsx
// ✅ Correct — import and use the named component
<DialogCorpusIntro open={open} onOpenChange={setOpen} />
<SheetCitationSource open={!!citation} citation={citation} onOpenChange={() => setCitation(null)} />

// ❌ Forbidden — inline composition of a primitive
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    <DialogTitle>{t("title")}</DialogTitle>
    ...
  </DialogContent>
</Dialog>
```

## Implementation checklist

When extracting a component:

1. Create the file at the correct path.
2. Name the exported component following the convention.
3. Accept the minimal props: `open`, `onOpenChange`, data props, callbacks.
4. Move all internal state (form state, loading, fetched lists) inside.
5. Replace every inline usage with the named import.
6. Delete the inline primitive usage — leave no orphan `<Dialog>` behind.

## Conditional rendering of dialogs / sheets

Modals and side panels are rendered **at the page level**, not nested inside a
content component. The visibility state lives in the page's client component:

```tsx
// ✅ Correct
export function ConstituerClient(...) {
  const [introOpen, setIntroOpen] = useState(false)
  const [citation, setCitation] = useState<Citation | null>(null)
  return (
    <>
      <LayoutCorpusDocumentList ... />
      <DialogCorpusIntro open={introOpen} onOpenChange={setIntroOpen} />
      <SheetCitationSource open={!!citation} citation={citation} onOpenChange={() => setCitation(null)} />
    </>
  )
}

// ❌ Forbidden — dialog nested inside a content card
<CardCorpusSummary>
  <Dialog>...</Dialog>  {/* state trapped, can't be opened from elsewhere */}
</CardCorpusSummary>
```

## Onboarding intros are dialogs

The two "guided intro" dialogs are first-class extracted components:

- `components/dialogs/corpus/intro.tsx` → `DialogCorpusIntro`
- `components/dialogs/research/intro.tsx` → `DialogResearchIntro`

They are auto-opened on first visit using persisted per-user "seen" state
(see [memory.md](memory.md) and [api-routes.md](api-routes.md)) and are
re-openable via the `?` button next to the page heading. The `?` button is its
own extracted component: `components/buttons/onboarding/reopen.tsx` →
`ButtonOnboardingReopen`.

## Scope

This rule applies to all files under:

- `app/` (pages, layouts, route components)
- `components/` (any component that currently embeds primitives inline)

Shared primitives from `components/ui/` (shadcn-generated) are exempt — they
**are** the primitives. The rule governs their consumers, not their definitions.

See [new-primitives.md](new-primitives.md) for when (rarely) a new primitive in
`components/ui/` is justified.
