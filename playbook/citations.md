# Citations Rule

## Rule

Inside a note body, a citation is written as:

```
[[<ark>|<label>|<folio>]]
```

This syntax is the single source of truth for note→BnF links. It is parsed
out of `note.body_md` by `models/notes/service.ts` into structured `citation`
rows and rendered as an inline `BadgeArkCitation` pill by the note renderer.
External URLs are **derived** from `(ark, folio)` — never stored, never
constructed inline.

See [doc 03 — Citation syntax](../design/docs/03-data-model.md#citation-syntax)
and [doc 06 — IIIF / external links](../design/docs/06-bnf-mcp.md#iiif--external-links).

## Anatomy

- `<ark>` — the document's ARK, e.g. `ark:/12148/bpt6k2839841`.
- `<label>` — the short, human-readable source label the agent chose, e.g.
  `Le Figaro, 6 mai 1889`. Free text, may contain spaces; pipes (`|`) and
  closing brackets (`]]`) are escaped (see below).
- `<folio>` — the IIIF `vue` (page index, integer ≥ 1).

Example in a note body:

```md
…« fête du travail et de la paix ». [[ark:/12148/bpt6k2839841|Le Figaro, 6 mai 1889|1]]
```

## Why folio is required ✅

Folio is what makes "click a citation → open the exact page on the BnF"
work. Every citation carries it; it is **not** optional. If retrieval
genuinely cannot pin a folio (rare), the agent must say so in prose and not
emit a citation rather than emit a fake one. See
[doc 04 — Folio-level citations](../design/docs/04-agent-flows.md#flow-b--research-step-3).

This is also enforced server-side: the citation parser rejects citations
with a missing or non-integer folio (raises `invalid_citation` for the agent
to fix on the next turn).

## Where citations live in code

```
lib/citations/
  syntax.ts        — parse/render the [[ark|label|folio]] syntax
  schema.ts        — DB shape of `citation` (see models/notes/schema.ts)
  external.ts      — derive IIIF / Gallica URLs from (ark, folio)
models/notes/
  service.ts       — on note.create/update, re-parse body_md → upsert citations
  schema.ts        — `citation` Prisma model + GetPayload type
components/badges/citations/
  ark.tsx          — BadgeArkCitation (the inline pill in note bodies)
components/sheets/citations/
  source.tsx       — SheetCitationSource (the side panel)
```

## Parsing

```ts
// lib/citations/syntax.ts
const CITATION_REGEX = /\[\[(ark:\/\d+\/[A-Za-z0-9]+)\|((?:[^|\]]|\\\||\\\])+)\|(\d+)\]\]/g

export type ParsedCitation = { ark: string; label: string; folio: number; index: number; length: number }

export function parseCitations(body: string): ParsedCitation[] {
  const out: ParsedCitation[] = []
  for (const match of body.matchAll(CITATION_REGEX)) {
    out.push({
      ark:   match[1],
      label: unescape(match[2]),
      folio: Number(match[3]),
      index: match.index!,
      length: match[0].length,
    })
  }
  return out
}

function escape(s: string)   { return s.replaceAll("|", "\\|").replaceAll("]]", "\\]]") }
function unescape(s: string) { return s.replaceAll("\\|", "|").replaceAll("\\]]", "]]") }

export function renderCitation(c: { ark: string; label: string; folio: number }): string {
  return `[[${c.ark}|${escape(c.label)}|${c.folio}]]`
}
```

Rules:
- The regex is the **single** definition of valid citation syntax. Any code
  that inspects note bodies (parser, renderer, validator) uses
  `CITATION_REGEX` or `parseCitations()` — never a hand-rolled scan.
- Pipes and `]]` in labels are escaped with `\` on write, unescaped on read.
- The parser is strict on the ARK (must match `arkSchema`) and on the folio
  (must be a positive integer). Mismatches are dropped silently from the
  rendered output and reported to the agent as `invalid_citation` warnings
  in the tool result.

## Persistence (a derived projection)

When `note.create` / `note.update` is called, `NoteService` re-parses
`body_md` and upserts the `citation` rows for that note. The rows are a
**derived projection** — never edited independently of the body.

```ts
// models/notes/service.ts
static async upsertCitations(noteId: string, body: string, projectId: string) {
  const parsed = parseCitations(body)
  // Validate ARKs against the project's corpus membership (any version).
  const knownArks = new Set(await CorpusQueries.allArksInProject(projectId))
  const valid = parsed.filter(p => knownArks.has(p.ark))
  await prisma.$transaction([
    prisma.citation.deleteMany({ where: { noteId } }),
    prisma.citation.createMany({
      data: valid.map(p => ({ noteId, ark: p.ark, folio: p.folio, label: p.label })),
    }),
  ])
  return {
    citationCount: valid.length,
    rejected: parsed.filter(p => !knownArks.has(p.ark)).map(p => p.ark),
  }
}
```

Rules:
- Citations whose ARK is **not in the project's corpus** are dropped from the
  DB projection and returned as `rejected[]` so the tool handler can report
  them to the agent (`invalid_citation`). The body itself keeps the offending
  citation text — the user can see it grey/struck in the renderer.
- `citation` rows feed the side panel and any future "all citations across
  notes" indexing — not the renderer (the renderer parses the body
  directly, so an edit in flight always renders correctly).

## Rendering

The note renderer (a small server component or client renderer) walks the
parsed citations and replaces each match with a `BadgeArkCitation`:

```tsx
// components/badges/citations/ark.tsx
"use client"
type Props = { ark: string; label: string; folio: number; onClick: () => void }

export function BadgeArkCitation({ ark, label, folio, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
    >
      <BookOpen className="h-3 w-3" />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">· f{folio}</span>
    </button>
  )
}
```

Clicking it opens the `SheetCitationSource` (see [componentization.md](componentization.md))
on the right side of the workspace.

## External URLs — derived only

```ts
// lib/citations/external.ts
import { IIIF_IMAGE_URL, GALLICA_ITEM_URL, IIIF_MANIFEST_URL } from "@/lib/constants"

export function citationLinks(c: { ark: string; folio: number }, iiifManifest?: string | null) {
  return {
    image:    IIIF_IMAGE_URL(c.ark, c.folio),
    gallica:  GALLICA_ITEM_URL(c.ark, c.folio),
    manifest: iiifManifest ?? IIIF_MANIFEST_URL(c.ark),
  }
}
```

Rules:
- **Never store** a constructed IIIF URL alongside a citation row. Storage is
  duplication; if the template changes, every stored URL is stale.
- **Always prefer** `Document.iiifManifestUrl` when present (the MCP gave us
  a canonical manifest); fall back to the template otherwise.
- The side panel always offers all three links so the librarian can pick
  the surface they want.

## The side panel

```tsx
// components/sheets/citations/source.tsx
"use client"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { citationLinks } from "@/lib/citations/external"
import { useDocument } from "@/hooks/api/documents"

type Props = {
  citation: { ark: string; folio: number; label: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SheetCitationSource({ citation, open, onOpenChange }: Props) {
  const t = useTranslations("citations.panel")
  const { data: doc } = useDocument(citation?.ark)
  if (!citation) return null
  const links = citationLinks(citation, doc?.iiifManifestUrl)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{citation.label}</SheetTitle>
          <SheetDescription>{citation.ark} · f{citation.folio}</SheetDescription>
        </SheetHeader>
        <img src={links.image} alt={citation.label} className="mt-4 max-w-full" />
        <div className="mt-4 flex flex-col gap-2">
          <a href={links.gallica}  target="_blank" rel="noopener noreferrer">{t("openGallica")}</a>
          <a href={links.manifest} target="_blank" rel="noopener noreferrer">{t("manifest")}</a>
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

The selected citation lives in URL state (`?ark=...&folio=...`) so it survives
a refresh and is shareable (see [client-patterns.md §5](client-patterns.md)).

## Citations in agent chat

When the research agent answers in chat (not in a note), the response carries
a `cites: [{ ark, label, folio }]` field appended to its assistant message
metadata. The chat renderer shows them as a horizontal row of
`BadgeArkCitation` chips under the answer. Each chip opens the same side
panel as a note citation.

Rules:
- Chat citations are **not** persisted as `citation` rows — they live only
  in the assistant message's structured metadata. Citations become durable
  only when the agent calls `note.create` / `note.update` with a body that
  contains them.
- The agent must include `cites[]` for every assistant turn that made
  factual claims, even if it didn't write a note that turn.

## Forbidden patterns

```ts
// ❌ Hand-rolled scan of note bodies
const matches = body.split("[[").map(...)   // → use parseCitations()

// ❌ Storing constructed IIIF URLs in the citation row
await prisma.citation.create({ data: { ..., imageUrl: `https://gallica.bnf.fr/${ark}/...` } })
// → derive at render time

// ❌ Citation without a folio
const cite = `[[${ark}|${label}]]`
// → folio is required; if you can't pin one, don't cite

// ❌ Inventing a folio to satisfy the parser
const fakeFolio = 1
// → the agent must call rag.query and use the folio it returned

// ❌ Rendering citations from the `citation` DB rows instead of the body
{citations.map(c => <BadgeArkCitation key={c.id} ... />)}
// → render from the parsed body; `citation` rows are for indexing, not display

// ❌ Allowing a citation whose ARK is not in the project's corpus
// → drop silently from the projection, surface in `rejected[]`
```

## Relation to other rules

- [mcp-client.md](mcp-client.md): the IIIF URL templates live in
  `lib/constants.ts` (per [constants.md](constants.md)); the citation system
  consumes them but doesn't define them.
- [agent-streaming.md](agent-streaming.md): the research agent's
  `note.create` / `note.update` tool returns
  `{ citationCount, rejected[] }` so the agent can self-correct invalid
  citations.
- [corpus-versioning.md](corpus-versioning.md): the corpus membership check
  for citation validity uses `CorpusQueries.allArksInProject(projectId)` —
  any version, not just `head`/`ingested`, because notes outlive corpus
  edits and shouldn't be invalidated by a later removal.
