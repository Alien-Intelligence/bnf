# New UI Primitive Rule

## Rule

Do not create a new UI primitive in `components/ui/` unless all five gates
below pass. Failing any one means you do not create a primitive — you either
use what exists, add a variant to an existing component, or extract a named
feature component instead.

## The five gates (all must pass)

### Gate 1 — Not in shadcn
Check https://ui.shadcn.com/docs/components first. If it exists in shadcn,
install it: `npx shadcn@latest add <name>`. Stop here.

### Gate 2 — Not composable from existing primitives
Can you build this from existing shadcn components (`Card`, `Dialog`,
`Popover`, `Tabs`, `Collapsible`, …)? If yes, compose and extract a named
feature component per [componentization.md](componentization.md). Stop here.

### Gate 3 — Behaviorally novel, not just visually different
A new primitive must encapsulate **interaction logic or accessibility
behaviour** that doesn't exist yet. Different border or padding never
qualifies — that is a Tailwind variant or a `className` prop. Ask: *if I
strip all the CSS, does this component still do something unique?* If no,
stop.

### Gate 4 — Truly domain-agnostic
The component must have zero BnF vocabulary. No "corpus", "ARK", "folio",
"citation", "session", "memory", "ingest". Its name, props, and internals
must read as pure UI language. If you cannot describe it without mentioning
the feature, it is a feature component, not a primitive. Stop.

### Gate 5 — Used across 3+ unrelated feature areas
Used in Constituer AND Rechercher AND somewhere unrelated (e.g. projects
list, auth). One feature is not enough. Two is not enough.

## Where it lives

```
components/ui/<name>.tsx
```

No subdirectory, no feature folder. This is the same place shadcn components
live, with the same conventions: named exports, `cn()` for class merging,
forwarded refs where appropriate.

It does **not** follow `components/<type>/<feature>/<name>.tsx` — because it
has no feature. It IS the type.

## Examples

### Legitimate primitives the BnF app may need

- `components/ui/streaming-text.tsx` — accessible token-by-token text
  renderer. Behaviorally novel (handles `aria-live`, smooth append), used by
  both the corpus chat and the research chat, possibly by ingest log views.
- `components/ui/facet-bar.tsx` — a clickable horizontal bar with a count and
  a "%-of-total" fill. Used by the corpus facet chart and (if added) by any
  future analytics view.
- `components/ui/histogram.tsx` — a clickable period bin chart. Generic enough
  to plot a corpus period distribution **and** an ingest progress timeline.

Each of these earns its place only after a second consumer is in the codebase
— add to a feature component first, promote to a primitive after the third
use.

### Rejected — should be a variant
```tsx
// ❌ "I need a primary CTA button" → add a variant to Button
const PrimaryButton = () => <button className="bg-primary ..." />

// ✅ Use existing Button
<Button variant="default">…</Button>
```

### Rejected — should be a named feature component
```tsx
// ❌ "I need a corpus ARK pill" → domain vocabulary → feature component
components/ui/ark-pill.tsx

// ✅ Extract it as a feature component
components/badges/citations/ark.tsx → BadgeArkCitation
```

### Rejected — composable from existing primitives
```tsx
// ❌ "I need a card with a collapsible body for the filter drawer"
// Card + Collapsible both exist → compose them as a feature component:
components/cards/corpus/filters-drawer.tsx → CardCorpusFiltersDrawer
```

## The summary test

Before creating a new primitive, answer out loud:

1. Is it in shadcn? → install it.
2. Can I compose it from what exists? → compose and extract.
3. Does it do something new without CSS? → if no, it's a variant.
4. Does it mention any BnF concept? → if yes, it's a feature component.
5. Will it serve three unrelated features? → if no, it's a feature component.

Only when all five answers say "yes, this is a primitive" do you build one.
