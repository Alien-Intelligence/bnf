# BnF Client Rule

## Rule

The app reaches BnF through **two** runtime paths, and **all direct egress goes
through the BnF broker** (the single chokepoint that owns the OAuth credential
and the shared rate caps):

1. **Resolution & canonicalization** — the app's own code. `BnfDirectClient`
   (`lib/bnf/direct.ts`) resolves ARKs to metadata and upgrades catalogue
   notices to their digitized Gallica ARK. It talks to the **broker**
   (`lib/bnf/broker-client.ts`), which fronts the ungated BnF hosts
   (`oai.bnf.fr`, `catalogue.bnf.fr`, `data.bnf.fr`).
2. **Agent search & browse** — the corpus agent's `bnf__*` tools (search
   Gallica/Catalogue, find person/work, read document text). These are **not**
   app code: the chat-sdk wires the BnF MCP server in-band as an `mcpServers`
   entry (`lib/agent/tools/registry-factory.ts`), and that server makes its own
   BnF calls. This is the one path that does **not** go through the broker.

The ingest worker is a third egress (IIIF manifest/ALTO/image via
`worker/src/prepare/bnf-api.ts`), also broker-routed — see
[ingestion-jobs.md](ingestion-jobs.md).

> ⚠️ There is **no** `BnfMcpClient` and no `getBnfClient()` singleton anymore.
> Resolution moved off the MCP onto the broker-routed `BnfDirectClient`. The MCP
> server is reached only in-band by the agent. See [doc 06](../design/docs/06-bnf-mcp.md)
> for the MCP contract; its tool surface is ⛔ owned by Alien.

## Egress map — know which path you're on

| Need | Path | Through the broker? |
|---|---|---|
| Resolve ARK → metadata (corpus add) | `BnfDirectClient.resolveArks` → broker → `oai.bnf.fr` / `catalogue.bnf.fr` | ✅ |
| `cb…` notice → digitized `bpt6k…` ARK | `BnfDirectClient.canonicalizeArks` → broker → `data.bnf.fr` SPARQL + catalogue SRU | ✅ |
| Stage bare ARK → metadata (buffer_add) | `BnfDirectClient.resolveArksForStaging` → broker → `oai.bnf.fr` / catalogue SRU (never the manifest: its bucket is ingestion's) | ✅ |
| Worker ingest (manifest/ALTO/image) | `worker/src/prepare/bnf-api.ts` → broker → `openapiproext.bnf.fr` | ✅ |
| Agent search / browse / read | chat-sdk `mcpServers` → **BnF MCP server** | ❌ (separate egress) |
| User-facing Gallica links / `<img>` | derived URLs (`lib/constants.ts`) → public `gallica.bnf.fr`, in the browser | ❌ (by design) |

The broker holds the BnF KEY/SECRET and enforces the shared 300/min global +
40/min manifest caps. The app and worker hold **no** BnF credentials. See
[ingestion-jobs.md](ingestion-jobs.md) and the broker service (`broker/`).

## Resolution: `BnfDirectClient` + the broker

```ts
// lib/bnf/direct.ts — import "server-only" is the first line.
export class BnfDirectClient {
  resolveArk(ark: string): Promise<BnfMcpDocumentDetail>
  resolveArks(arks: string[]): Promise<Array<BnfMcpResolveResult | BnfMcpResolveError>>
  classifyCanonical(ark: string): Promise<CanonicalizeOutcome>
  canonicalizeArks(arks: string[]): Promise<CanonicalizeOutcome[]>
}
```

Rules:
- `import "server-only"` first. BnF egress is server-side; nothing here may
  reach the browser bundle.
- The result types (`BnfMcpDocumentDetail`, `BnfMcpResolveResult`,
  `BnfMcpResolveError`) live in `lib/bnf/types.ts`. The `BnfMcp` name prefix is
  legacy — the shapes are MCP-agnostic now.
- Every fetch goes through `broker-client.ts` when `BNF_BROKER_URL` is set
  (prod + local). Absent → it falls back to the legacy relay / direct path. The
  per-host transport and retry are encapsulated; callers see only the methods
  above.
- The Service / resolver layer calls it — **never a route handler directly**.
  `kickResolve` (`lib/documents/resolver.ts`) is the entry point, invoked by the
  corpus `add` / `promote` / `retry` routes and the agent's `corpus` tool.

## Agent search: in-band MCP, not a client object

The agent's BnF tools (`bnf__bnf_search_gallica`, `bnf__bnf_search_catalogue`,
`bnf__bnf_get_document_info`, …) are registered on the chat-sdk tool registry as
an `mcpServers` entry:

```ts
// lib/agent/tools/registry-factory.ts (sketch)
const sessionId = await openMcpSession(BNF_MCP_URL, BNF_MCP_TOKEN, signal) // may be null (stateless server)
mcpServers = [{ name: "bnf", url: BNF_MCP_URL, headers: { Authorization: `Bearer ${BNF_MCP_TOKEN}`, ...(sessionId && { "Mcp-Session-Id": sessionId }) } }]
```

Rules:
- The MCP server is **optional**: if `BNF_MCP_URL` / `BNF_MCP_TOKEN` are absent
  or the handshake fails, the app's corpus/memory/ingest tools still work — the
  agent just has no BnF search for that turn. Never crash the dev server.
- The BnF MCP runs **stateless** (multi-replica); the `initialize` handshake may
  return no session id and one must not be required — see `lib/mcp/session.ts`.
- These calls do **not** flow through the broker. If the MCP server shares the
  BnF credential with the broker, the two contend for the same quota with no
  coordination — a known seam. Don't add new BnF egress here; if you need a new
  BnF capability in app code, add it to `BnfDirectClient` (broker-routed).

## Normalization is a boundary funnel

Resolved payloads carry BnF/Dublin-Core types and MARC/ISO codes. The app uses a
small fixed vocabulary for facets (`docType`, `lang`, `source`). `normalizeMany`
is the single funnel between a resolved document and a `Document` row:

```ts
// lib/mcp/normalize.ts
export function normalizeMany(
  docs: BnfMcpDocumentDetail[],
  opts?: { unknownDocTypeHook?: (raw: string, source: string) => void },
): NormalizedDocument[]
```

Rules:
- The vocab maps live in `lib/mcp/vocab.ts` (`GALLICA_DOC_TYPE`,
  `MARC_TO_ISO_LANG`, `mapCatalogueDocType`, `sourceFromArk`) — **not** in
  `lib/constants.ts`. They are the BnF boundary, not app-wide config.
- Unknown values fall back to a generic bucket (`"other"` for docType, the raw
  lowercase string otherwise) — never `null`/empty (CLAUDE_ERROR_PATTERNS
  empty-defaults).
- `rawMetadata` always carries the untouched payload for traceability. If BnF
  relabels a type tomorrow, the evidence is in the database.
- `normalizeDocument` returns `null` for an unusable record (e.g. no title);
  the resolver treats that as a resolve failure, not a silent empty row.
- The resolver inserts with `(projectId, ark)` de-dup. Re-adding an existing ARK
  is a no-op at the document level; only `corpus_membership` advances.

## ARK is an opaque string — never construct one

```ts
// ✅ ARKs come from search results / the corpus; pass them as opaque tokens
const arks = hits.map(h => h.ark)

// ❌ Never invent an ARK
const ark = `ark:/12148/${id}`   // forbidden
```

Validation is `arkSchema` in `models/corpus/types.ts`:

```ts
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "invalid ARK")
```

This protects route handlers from junk ARKs; it is **not** the canonical format
spec. The BnF uses extensions like `ark:/12148/btv1b8470216w` (the regex matches
them). Extend the regex when you hit a real ARK it rejects, not preemptively.

## IIIF & Gallica links — derived, not stored

User-facing links to BnF are computed from `ark + folio` via the helpers in
`lib/constants.ts` (see [constants.md](constants.md) and
[citations.md](citations.md)): `IIIF_IMAGE_URL(ark, folio)`,
`GALLICA_ITEM_URL(ark, folio)`, `IIIF_MANIFEST_URL(ark)`.

- These point at **public** `gallica.bnf.fr` and render in the librarian's
  browser — they must **not** use the broker or the authenticated
  `openapiproext.bnf.fr` host (the browser has no Bearer token).
- When a resolved record carries an `iiifManifestUrl`, prefer it; otherwise fall
  back to the template. `Document.iiifManifestUrl` may be null; the template is
  the always-available fallback.

## Rate limits & backoff — the broker owns them ✅

For the broker-routed paths, the broker is the rate authority: OAuth
single-flight token, global + manifest token buckets, and 429/`Retry-After`
handling (freezes the bucket to the next clock-minute boundary). Clients treat a
broker 429 / transport error as **transient** and retry with backoff; they never
manage BnF rate state themselves. Running at the provisioned ceiling means
occasional 429s — that's expected and absorbed. See the broker service and
[ingestion-jobs.md](ingestion-jobs.md).

### Agent MCP path — the app throttles it ✅

mcp-bnf has **no** limiter, and neither does the platform proxy behind it: on
2026-09-30 one corpus session fanned out to 7 sub-agents and made 2 548
catalogue searches in 2.5 h, blowing the 100/min quota (346 × 429, 252 × 500).
The app therefore rate-limits **every** BnF MCP call it dispatches, in
`lib/mcp/rate-limit.ts`: one process-wide set of sliding-window limiters
(global + one per BnF API: catalogue, Gallica SRU, Gallica-IIIF,
date-périodique, graphe), set from the required `BNF_MCP_RATE_*` env (helm
`config.bnfMcpRate`, the interface-key quotas × 0.95, divided by
`replicaCount`). **The guarantee:** in ANY 60 s sliding window, the weighted
requests a replica sends to one BnF API never exceed that API's limit, and all
of them together never exceed the global limit. Each ledger counts a call
from its grant until 60 s after its **send**: a call granted on the global
limiter that still waits on its API limiter is a reservation that counts in
every window and never ages, and it is stamped with its send time when it
leaves. A call is granted only when the reservations plus the trailing
window's sends plus its own weight fit; there is no burst on top and no
overdraft, and a call heavier than the whole limit is refused. The flood test
runs eight agents concurrently on a virtual scheduler and asserts the per-API
and the global sliding-window peaks of the sent calls. Two enforcement points
share those limiters:

- **(a) app-made calls** — `callBnfTool` acquires before `fetch`
  (`corpus_search` and its zero-result probe).
- **(b) SDK-dispatched raw `bnf__*` tools** — `withBnfRateLimit(registry)`
  (`lib/mcp/rate-limited-registry.ts`) wraps `ToolRegistry.dispatch`. Every
  chat-sdk dispatch site calls `.dispatch` on the registry it was handed, so
  the decorator sees the model's raw calls in the parent turn AND in every
  `spawn_research` child. `onToolStart` cannot do this: it is sync-only and
  cannot veto.

Every call reserves on the global limiter, then on its API limiter, against
ONE finite deadline computed when it is enqueued (a deadline already past is
refused before any grant); `acquireBnfMcp` stamps both as sent when it
returns. `callBnfTool` fetches in the same synchronous run; the registry
decorator warms the SDK registry's MCP catalogue before acquiring, so the
inner `callMcpServerTool` → `fetch` follows the stamp within microtasks (only
a failed warm-up can add one bounded discovery RPC in between — see "WHERE
THE STAMP SITS" in rate-limit.ts). A cancelled turn releases the grant. A
reservation that is neither sent nor released within `maxWaitMs` +
`BNF_MCP_TIMEOUT_MS` is released and logged. The rules:

- **Shed, never thrown.** A call that cannot be granted within
  `BNF_MCP_RATE_MAX_WAIT_MS` is shed with a structured `{ success: false,
  rate_limited: true, api, error: « Quota BnF saturé … » }` tool result — never
  a throw out of the loop, never a call that reaches BnF. Every grant a call
  took is **released** when the call is not sent — its API limiter shed it, its
  turn aborted while it waited or as the grant landed — so refused catalogue
  retries cannot starve IIIF/Gallica/graphe.
- **Unknown tools are refused.** A `bnf__<tool>` absent from `BNF_MCP_TOOLS`
  (a bare `bnf__` included) has no API limiter, so the decorator refuses it (`{ success: false, refused:
  "bnf_call_refused", error }`) and never sends it. A new mcp-bnf tool ships
  only once it is mapped in `BNF_MCP_TOOL_API`.
- **Weights are upstream requests.** `bnfMcpCallWeight`: a full-text read
  (`bnf_get_document_text`) is 2 + pages (OAI record + pagination + one ALTO
  per page, default 10, max 200); `bnf_find_person` 3, `bnf_find_work` 2,
  everything else 1. A `max_pages` that is not an integer is refused — mcp-bnf
  would coerce `"150"` to 150 pages.
- **A BnF 429 pauses the API.** When BnF answers 429 anyway — HTTP 429 on
  `callBnfTool`, the SDK's `HTTP 429` transport error, or mcp-bnf's soft
  envelope `{ success: false, status_code: 429 }` in the tool result — the
  API's limiter is paused for `Retry-After` when sent, otherwise until the next
  clock-minute boundary, capped at 5 minutes (`BNF_RATE_LIMIT_FREEZE_MAX_MS`).
- **Cancellation is honoured while queued.** A caller whose turn aborts leaves
  the FIFO queue at once, not when its turn comes.
- **One acquire per MCP call**: a model retry acquires again.

**Rule: every `createToolRegistry(...)` built in app code MUST be wrapped with
`withBnfRateLimit`.** The two call sites today are
`lib/agent/tools/registry-factory.ts` and `lib/agent/tools/spawn.ts`. The
wrap is pinned on the SDK's real dispatch paths by
`lib/mcp/rate-limited-registry-runner.test.ts`: `runOpenRouterSdk` (production)
and `runClaudeSdk`, over `buildTurnScopedRegistry`, against local fake model
endpoints and a fake mcp-bnf.

**Config is validated at boot.** When `BNF_MCP_URL` is set, `lib/env.ts`
parses the seven `BNF_MCP_RATE_*` values on import (`instrumentation.ts`
imports it first), with `BNF_MCP_RATE_MAX_WAIT_MS` ≤ 60 s; a missing value
stops the process instead of failing its first turn. `withBnfRateLimit`
re-asserts it when a registry is built. The chart renders every rate with
`required`, and a per-replica share below 1/min fails the render
(`bnf-demo.bnfRateShare`) instead of flooring up past the quota.

Not covered, on purpose: MCP `tools/list` discovery (never reaches BnF);
other mcp-bnf clients sharing the platform connectors (none in prod besides
this app); the upstream HTTP requests a tool makes internally beyond the
weights above — mcp-bnf's 1 h SRU cache keeps real upstream traffic at or
below the counted traffic. The limiters are per replica; the chart divides the
rates by `replicaCount` so a scale-out stays under quota by construction (see
`values.yaml`).

## Auth

```bash
# Agent's in-band MCP path (lib/agent/tools/registry-factory.ts, lib/mcp/session.ts)
BNF_MCP_URL=https://…
BNF_MCP_TOKEN=…           # long-lived service Bearer for the BnF MCP server

# Broker-routed path: the BnF OAuth client_credentials live ONLY in the broker
# (broker/.env / the bnf-demo-prod secret). App + worker hold no BnF creds.
BNF_BROKER_URL=http://…   # where app/worker POST their fetches
```

Each required var throws at startup if missing (no default — empty-defaults
anti-pattern). Never logged, never exposed to the client bundle.

## The BnF boundary

BnF (whether via the broker or the MCP) is **read-only discovery, resolution,
and content**. It does **not**:

- Store any user state (corpus, sessions, notes, memory).
- Ingest, OCR, chunk, or embed (that's the worker — see
  [ingestion-jobs.md](ingestion-jobs.md)).
- Know about projects, sessions, or users.

If you want to "save something on the BnF side" or "ask BnF what I added
before", you are using the wrong tool — that state belongs to the app's Corpus
service. Keep the boundary crisp.

## Forbidden patterns

```ts
// ❌ Calling BnF from a route handler
export const POST = withAuth(async (req, user, bouncer, ctx) => {
  const client = new BnfDirectClient()
  await client.resolveArks(arks)        // ← BnF egress from a route
})
// → resolution runs in the service/resolver layer (kickResolve); search is the agent's MCP tool

// ❌ New app-side BnF egress that bypasses the broker
await fetch("https://gallica.bnf.fr/…")  // → go through BnfDirectClient / broker-client

// ❌ Pointing a server fetch at the authenticated host without the broker
await fetch("https://openapiproext.bnf.fr/…")  // 401 — the broker owns the token

// ❌ Storing raw fields without normalization
await prisma.document.create({ data: { lang: raw.dc_language } })
// → use normalizeMany / the vocab maps

// ❌ Inventing an ARK
const ark = `ark:/12148/${slug(title)}`

// ❌ Constructing an IIIF URL by hand
const url = `https://gallica.bnf.fr/${ark}/f1/full/full/0/native.jpg`
// → IIIF_IMAGE_URL(ark, folio)

// ❌ Reading a BnF token in a React component
process.env.BNF_MCP_TOKEN   // would leak into the client bundle
```

## Relation to other rules

- [models.md](models.md): `lib/bnf/` + `lib/mcp/normalize.ts` are imported by
  `models/corpus/service.ts` / the resolver, never by `queries.ts`,
  `policy.ts`, `schema.ts`, or `types.ts`.
- [constants.md](constants.md): IIIF templates + the BnF tool-name constants
  live in `lib/constants.ts` and `lib/agent/tools/constants.ts`.
- [agent-streaming.md](agent-streaming.md): the agent's `bnf__*` tools are the
  in-band MCP server's tools (registered via `mcpServers`); the tool runtime
  emits the `tool_call`/`tool_result` SSE events.
- [ingestion-jobs.md](ingestion-jobs.md): the worker re-resolves + fetches IIIF
  through the broker; the ingest may re-resolve an ARK to pick up upstream
  metadata changes (treat as remove+add in the next delta).
- [corpus-versioning.md](corpus-versioning.md): resolved documents feed
  `CorpusService`; membership/versioning is app state, never BnF state.
```
