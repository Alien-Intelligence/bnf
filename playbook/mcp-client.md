# BnF MCP Client Rule

## Rule

The BnF MCP server is provided by Alien and is the **only** way the app
discovers BnF catalogue holdings or resolves ARKs to metadata. The MCP is
accessed through a single client in `lib/mcp/bnf-client.ts`. Everything else
in the codebase calls that client — never the MCP transport directly.

See [doc 06](../design/docs/06-bnf-mcp.md) for the contract overview. The
MCP's concrete tool surface is ⛔ owned by Alien; this file describes the
*contract* the app needs and the boundary the app enforces.

## What the client exposes

```ts
// lib/mcp/bnf-client.ts
import "server-only"

export interface BnfSearchFilters {
  dateFrom?: string       // ISO month/year, e.g. "1889-05"
  dateTo?:   string
  docType?:  string       // "press" | "book" | "image" | "manuscript" | ...
  lang?:     string       // normalized 2-letter, e.g. "fr"
  source?:   string       // "gallica" | "retronews" | ...
}

export interface BnfHit {
  ark:    string
  title:  string
  author: string | null
  year:   number | null
  type:   string
  lang:   string
  source: string
  raw:    unknown         // untouched MCP payload, persisted in raw_metadata
}

export interface BnfResolved {
  ark:               string
  title:             string
  author:            string | null
  year:              number | null
  docType:           string
  lang:              string
  source:            string
  pages:             number | null
  excerpt:           string | null
  iiifManifestUrl:   string | null
  raw:               unknown
}

export class BnfMcpClient {
  search(query: string, filters: BnfSearchFilters, limit: number): Promise<{ total: number; hits: BnfHit[] }>
  resolve(arks: string[]): Promise<BnfResolved[]>
}

export function getBnfClient(): BnfMcpClient
```

Rules:
- `import "server-only"` is the first line. The MCP credentials live
  server-side and must never reach the browser bundle.
- The client exposes **two** methods: `search` and `resolve`. Everything else
  the app needs (the IIIF link templates) is computed from an ARK + folio
  via `lib/constants.ts` (see [constants.md](constants.md) and
  [citations.md](citations.md)).
- The client is a singleton per process — `getBnfClient()` returns the same
  instance. The transport, auth, and rate-limit state are encapsulated inside.

## Normalization is the client's job

The MCP returns BnF/Dublin-Core types and MARC/ISO codes. The app uses a
small, fixed vocabulary for facets (`type`, `lang`, `source`). The client
normalizes on the way in; **callers always see normalized values**.

```ts
// lib/mcp/normalize.ts
export const LANG_MAP: Record<string, string> = {
  fre: "fr", fra: "fr", fr: "fr",
  eng: "en", en: "en",
  lat: "la", la: "la",
  ita: "it", it: "it",
  ger: "de", deu: "de", de: "de",
  // ...
}

export const DOC_TYPE_MAP: Record<string, string> = {
  "periodical":      "press",
  "press":           "press",
  "monograph":       "book",
  "book":            "book",
  "manuscript":      "manuscript",
  "still image":     "image",
  "engraving":       "estampe",
  "map":             "map",
  "illuminated manuscript": "enlum",
  "charter":         "charte",
  // ...
}

export const SOURCE_MAP: Record<string, string> = {
  "gallica.bnf.fr": "gallica",
  "retronews":      "retronews",
  "data.bnf.fr":    "databnf",
  // ...
}

export function normalizeLang(raw: string): string { return LANG_MAP[raw.toLowerCase()] ?? raw.toLowerCase() }
export function normalizeDocType(raw: string): string { return DOC_TYPE_MAP[raw.toLowerCase()] ?? "other" }
export function normalizeSource(raw: string): string { return SOURCE_MAP[raw.toLowerCase()] ?? raw.toLowerCase() }
```

Rules:
- The maps live in `lib/mcp/normalize.ts`. They are **not** in
  `lib/constants.ts` — they are the MCP boundary, not app-wide config.
- Unknown values fall back to a generic bucket (`"other"` for type, the raw
  lowercase string otherwise) — never to `null` or empty string (see the
  empty-defaults anti-pattern in CLAUDE_ERROR_PATTERNS).
- `raw_metadata` always carries the untouched MCP payload (`raw` field) for
  traceability. If the MCP changes how it labels a type tomorrow, the
  evidence is in the database.

## ARK is an opaque string — never construct one

```ts
// ✅ ARKs come from the MCP; we pass them around as opaque tokens
const hits = await client.search("Exposition 1889", { docType: "press" }, 50)
const arks = hits.map(h => h.ark)

// ❌ Never invent an ARK
const ark = `ark:/12148/${id}`   // forbidden
```

Validation happens via `arkSchema` in `models/corpus/types.ts`:

```ts
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "invalid ARK")
```

This regex protects route handlers from junk ARKs sent by a malicious or
buggy caller. It is **not** the canonical format spec — the BnF uses
extensions like `ark:/12148/btv1b8470216w`, and the regex matches them.
Extend the regex when you hit a real ARK it rejects, not preemptively.

## IIIF links — derived, not stored

The citation side panel and document detail panel link to the BnF via three
URL templates (see [constants.md](constants.md)):

- **IIIF image** (a single folio): `IIIF_IMAGE_URL(ark, folio)`
- **Gallica item page**: `GALLICA_ITEM_URL(ark, folio)`
- **IIIF manifest**: `IIIF_MANIFEST_URL(ark)`

When `bnf.resolve` returns an `iiifManifestUrl`, prefer it. Otherwise fall
back to the template. The `Document.iiifManifestUrl` column stores whichever
the MCP returned (may be null); the template is the always-available
fallback.

## Operational concerns

### Caching 🔶

- `bnf.search` results: cache by `(query, filters_hash, limit)` for 15
  minutes 🔶. The search results don't change minute to minute; cached
  results dramatically cut MCP load when an agent iterates queries.
- `bnf.resolve` results: cache by ARK indefinitely (until manual purge or
  a re-resolve job runs). MCP metadata is stable; if it changes, the next
  ingest's re-resolve picks it up (see [doc 07 edge cases](../design/docs/07-ingestion-jobs-and-corpus-delta.md#edge-cases-to-handle)).
- Implementation 🔶: Redis with `mcp:search:<hash>` / `mcp:resolve:<ark>`
  keys, gzipped JSON values.

### Rate limits and backoff ✅

The MCP fronts BnF services with their own rate limits. The client must:

- Use exponential backoff on 429/503 (`baseDelayMs = 200`, max 3 retries).
- Surface partial results on a query that hit a transient cap. The client
  returns `{ total, hits, partial: true }` 🔶 so the agent can decide whether
  to widen the query or retry.
- Never retry on 4xx other than 429.

### Pagination

Searches return thousands of hits. The client pages with `limit + offset`
(or a cursor if the MCP provides one ⛔). The agent's `bnf.search` tool
exposes only `limit` and lets the curation step do the work; the UI never
shows a paged catalogue browser — only the curated corpus.

### Auth

MCP credentials are environment-only:

```bash
BNF_MCP_URL=https://...
BNF_MCP_TOKEN=...
```

Loaded in `lib/mcp/bnf-client.ts` at module init. Throws at startup if
missing (no default — see the empty-defaults anti-pattern). Never logged,
never exposed to the client bundle.

## Adapting MCP results to app shapes

The transformation `resolveAndNormalize` is the single funnel between MCP
payloads and `Document` rows:

```ts
// lib/mcp/normalize.ts
export async function resolveAndNormalize(
  client: BnfMcpClient,
  projectId: string,
  arks: string[],
): Promise<DocumentInsert[]> {
  const resolved = await client.resolve(arks)
  return resolved.map(r => ({
    projectId,
    ark:      r.ark,
    title:    r.title,
    author:   r.author,
    year:     r.year,
    docType:  r.docType,    // already normalized inside resolve()
    lang:     r.lang,
    source:   r.source,
    pages:    r.pages,
    excerpt:  r.excerpt,
    iiifManifestUrl: r.iiifManifestUrl,
    rawMetadata: r.raw,
    resolvedAt: new Date(),
  }))
}
```

Rules:
- The MCP client's `resolve()` already returns normalized values; the funnel
  only maps to the DB shape. The maps live in **one** place
  (`lib/mcp/normalize.ts`).
- The Service layer (`CorpusService.addArks`) calls `resolveAndNormalize` and
  inserts the rows. The MCP client is never called from a route handler
  directly.
- Documents are inserted with `skipDuplicates: true` keyed on
  `(projectId, ark)`. Re-adding an ARK that already has a row is a no-op at
  the document level; only `corpus_membership` advances.

## The MCP boundary

The MCP is **read-only discovery and resolution**. It does **not**:

- Store any user state (corpus, sessions, notes, memory).
- Ingest, OCR, chunk, or embed anything (that's the job runner — see
  [ingestion-jobs.md](ingestion-jobs.md)).
- Know about projects, sessions, or users.

If you find yourself wanting to "save something on the MCP side" or "query
the MCP for what I've added before", you are using the wrong tool — that
state belongs to the app's Corpus service. Keep the boundary crisp.

## Forbidden patterns

```ts
// ❌ Direct MCP call from a route handler
export const POST = withAuth(async (req, user, bouncer, ctx) => {
  const client = getBnfClient()
  const hits = await client.search(query, {}, 50)   // ← MCP from a route
})
// → MCP is only called from services or tool handlers

// ❌ Storing raw MCP fields without normalization
await prisma.document.create({ data: { lang: hit.raw.dc_language } })
// → use the normalized `lang` from the BnfHit

// ❌ Inventing an ARK
const ark = `ark:/12148/${slug(title)}`

// ❌ Constructing an IIIF URL outside the template helpers
const url = `https://gallica.bnf.fr/${ark}/f1/full/full/0/native.jpg`
// Use: IIIF_IMAGE_URL(ark, folio)

// ❌ Reading BNF_MCP_TOKEN inside a React component
process.env.BNF_MCP_TOKEN   // would leak into the client bundle
```

## Relation to other rules

- [models.md](models.md): `lib/mcp/` is imported by `models/corpus/service.ts`
  and `models/ingest/service.ts`; never by `queries.ts`, `policy.ts`,
  `schema.ts`, or `types.ts`.
- [constants.md](constants.md): IIIF templates and the BnF tool name
  constants live in `lib/constants.ts` and `lib/agent/tools.ts`.
- [agent-streaming.md](agent-streaming.md): the agent's `bnf.search` and
  `bnf.resolve` tools are thin wrappers over `BnfMcpClient` methods; the
  tool handler is the only place that emits the corresponding
  `tool_call`/`tool_result` SSE events.
- [ingestion-jobs.md](ingestion-jobs.md): the ingest job may re-resolve ARKs
  through the MCP to pick up upstream metadata changes; treat the result as
  remove+add of that ARK in the next delta.
