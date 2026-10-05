# Agent Streaming Rule

## Rule

The two agent loops (corpus, research) run inside a single `AgentService`
that streams Server-Sent Events over `POST /api/sessions/:sid/messages`. The
SSE event vocabulary is fixed; client and server agree on it byte-for-byte.

Every assistant turn is persisted: messages, tool calls (inputs, outputs,
latencies), and the resulting side effects (corpus advance, note write,
memory write) are durable rows that survive a session reload.

See [doc 04](../design/docs/04-agent-flows.md) for the flow semantics and
[doc 08](../design/docs/08-prompting.md) for the system prompts.

## Where the code lives

The turn lifecycle (start, stream, persist, cancel, reattach) is owned by
`@alien/chat-sdk`'s durable `TurnRuntime`; the app supplies auth, the system
prompt, the tools and the persistence adapter.

```
app/api/sessions/[sid]/messages/route.ts
                          — POST (start a turn), GET (reattach), DELETE (cancel);
                            authorizes, then delegates to createChatHandler
models/agents/
  service.ts              — AgentService.buildSystemPrompt (→ PromptBuilder)
  schema.ts               — TURN_STATUS, TurnSnapshot; re-exports AppSession/Message/ToolCall
  types.ts                — Zod for the reattach query (streamQuerySchema)
  policy.ts               — AgentPolicy (post / stream / cancel)
  queries.ts              — AgentQueries (session + transcript reads)
lib/agent/
  persistence/prisma-adapter.ts — the SDK's ChatPersistenceAdapter over AppSession / Message / ToolCall
  runtime/reaper.ts       — boot sweep of turns a restart left "streaming"
  stream-event-types.ts   — STREAM_DOMAIN_EVENT, BUFFER_EVENT_KIND (no dependencies)
  stream-events.ts        — the domain-event zod contract, emitDomainEvent, parseStreamDomainEvent
  tools/
    constants.ts          — AGENT_TOOLS (see constants.md)
    registry-factory.ts   — buildTurnScopedCtx / buildTurnScopedRegistry (the SDK's buildTools seam)
    index.ts              — toolsForScope(scope)
    authorize.ts          — authorizeProjectTool / authorizeOnProject (the policy gate)
    failure.ts            — toolFailure / toolRefusal: the ONE failure shape
    corpus.ts, buffer.ts, memory.ts, note.ts, ingest.ts, rag.ts, doc.ts, spawn.ts, …
  prompts/
    builder.ts            — PromptBuilder (render + cached buildForSession)
    shared.ts             — preamble + memory rendering
    corpus.ts             — Step 1 prompt
    research.ts           — Step 3 prompt
lib/tools/
  display.ts              — toolCallErrored and the tool-result view helpers
  subagent-runs.ts        — SUBAGENT_EVENT_KIND, reduceSubagentRuns
hooks/api/
  turn-stream.ts          — useTurnStream(sessionId): adapter over the SDK's useChat
```

`messages/` is its own model directory for the persisted transcript; `agents/`
holds what produces it.

## The SSE event model (✅ fixed contract)

The wire format is `text/event-stream`. Two families of frames share it:

- **Chat events** (`text-delta`, `thinking-delta`, `tool-call-start`,
  `tool-call-input-delta`, `tool-call-end`, `tool-result`, `message-start`,
  `message-end`, `error`, …) are owned by `@alien/chat-sdk`
  (`ChatEvent`, `@alien/chat-sdk/events`). The app never redefines them.
- **Domain events** are the app's own, and have ONE definition:
  `lib/agent/stream-events.ts`. It holds a zod schema per event and the
  `StreamDomainEvent` union inferred from them. The server emits through
  `emitDomainEvent(ctx, event)` (typed: a tool cannot emit a payload outside
  the contract); the client parses every frame with `parseStreamDomainEvent`
  (`hooks/api/turn-stream.ts`), which logs and drops a payload that breaks the
  contract instead of folding it into the panels. Never hand-type a copy of an
  event on either side.

```ts
// lib/agent/stream-events.ts — the union the schemas infer
type StreamDomainEvent =
  | { type: "corpus_event";     data: { kind: "add"|"remove"; count: number; versionSeq: number } }
  | { type: "memory_event";     data: { kind: "write"; scope: MemoryScope; section: string; itemId: string } }
  | { type: "ingest_event";     data: { kind: "submitted"; jobId: string; status: string } }
  | { type: "note_event";       data: { kind: "created"|"updated"; noteId: string; title: string } }
  | { type: "buffer_event";     data: { kind: "added"|"removed"|"committed"|"cleared"; count: number; total: number } }
  | { type: "subagent_event";   data: SubagentEventData }   // lib/tools/subagent-runs.ts
  | { type: "compaction_event"; data: { coveredMessageCount: number; keptMessageCount: number; reused: boolean } }
```

`compaction_event` is emitted by the chat-sdk runtime; every other domain
event is emitted by an agent tool. There is no `forget` memory event: the
agent has no forget tool, and the memory dialog refetches after its own
DELETE.

The mapping to the prototype UI:

| Event | Renders as |
|---|---|
| `text-delta` (SDK) | Appended to the current assistant bubble |
| `tool-call-start` (SDK) | A `BadgeToolCall` chip — "bnf.search · via MCP" |
| `tool-result` (SDK) | The chip turns from spinner to ✓ or ✗ (`toolCallErrored`: the SDK's `isError`, or a `success: false` result) |
| `corpus_event` | An inline event row — "+412 documents · v8" |
| `memory_event` | An inline event row — "Mémoire mise à jour · Périmètre" |
| `note_event` | An inline event row — "Note créée · Réception…" + a Tab opens in Atelier |
| `ingest_event` | The CTA "Ouvrir Ingérer" appears in the chat |
| `buffer_event` | Refreshes the buffer pill / dialog (the corpus agent's "tampon": search results staged before a commit) |
| `subagent_event` | ONE row per `spawn_research` run: `spawn_research` emits a `start` and, on every path, exactly one terminal event with the same `runId`; the client folds them with `reduceSubagentRuns` (`lib/tools/subagent-runs.ts`). A run still open when its turn ended reads "interrompu" — domain events are live-only, so a reload or a dropped stream must never leave a spinner |
| `compaction_event` | A muted row when the context was compacted (a cache reuse is silent) |
| `message-end` (SDK) | Marks the assistant turn finished |
| `error` (SDK) | Toast + the turn is marked failed; a Retry button appears |

## The route

```ts
// app/api/sessions/[sid]/messages/route.ts (abridged)
const handler = createChatHandler<TurnScopedCtx>({
  persistence: createPrismaChatAdapter(),
  claude: { provider: env.AGENT_PROVIDER, /* model, maxToolTurns, system, … */ },
  buildTools: /* buildTurnScopedRegistry(scope, signal) */,
  buildToolContext: /* buildTurnScopedCtx(...) */,
})

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const session = await sessionWithProject(sid)
  if (!session) return notFound()
  await bouncer.with(AgentPolicy).authorize("post", { session, project: session.project })
  return handler.POST(req)
})
```

The route parses and authorizes; the SDK handler returns the SSE stream. The
handler is a module-scoped singleton so POST (start), GET (reattach) and
DELETE (cancel) share one runtime. The route does no streaming logic itself.

## The turn (server side)

The SDK runtime drives the model and the tool loop; the app's part is:

- **System prompt.** `system(req)` resolves the session and calls
  `AgentService.buildSystemPrompt`, which returns the cached prompt or renders
  a new one (see "Memory in the system prompt").
- **Tools.** `buildTools` returns `buildTurnScopedRegistry(scope, signal)`:
  the scope's tools (`toolsForScope`), the BnF MCP attachment, and the
  application-wide BnF rate limiter around every MCP call.
- **Persistence.** `createPrismaChatAdapter()` is the only code that maps the
  SDK's durable-turn contract onto `AppSession` / `Message` / `ToolCall`. A turn
  is one assistant `Message` row; every tool call is written as a `ToolCall`
  row with its input, output, status and latency before its result is
  streamed, so a reload shows the full history. `AppSession.activeMessageId`
  serializes turns (one streaming turn per session) and is the reattach
  pointer.

Rules:
- The SDK owns tokens and tool calls. Domain events (`corpus_event`,
  `memory_event`, `note_event`, `ingest_event`, `buffer_event`,
  `subagent_event`) are emitted by the **tool handlers** themselves through
  `emitDomainEvent(ctx, event)`, which the compiler checks against the
  contract.
- No route, service or tool writes `Message` or `ToolCall` rows itself — that
  is the adapter's job.

## Tool handlers

```ts
// lib/agent/tools/note.ts (abridged)
export const noteUpdateTool = defineTool<…, TurnScopedCtx>({
  name: AGENT_TOOLS.noteUpdate,
  inputSchema: z.object({ id: z.string(), title: …, body_md: … }),
  handler: async (input, ctx) => {
    const gate = await authorizeProjectTool(ctx, NotePolicy, "write")
    if (!gate.ok) return gate.result
    const target = await NoteQueries.getForProject(input.id, ctx.projectId)
    if (!target) return toolFailure(NOTE_NOT_FOUND_ERROR)
    const noteGate = authorizeOnProject(ctx, gate.project, NotePolicy, "update", target)
    if (!noteGate.ok) return noteGate.result
    const written = await NoteService.update(…)
    emitDomainEvent(ctx, { type: STREAM_DOMAIN_EVENT.NOTE, data: { kind: "updated", … } })
    return { note_id: written.id, title: written.title, … }
  },
})
```

Rules:
- Tool handlers re-run policy checks. The session being authorized to *post*
  does not authorize every tool: every mutating handler calls
  `authorizeProjectTool` first, and a check on a record found later (a note)
  goes through `authorizeOnProject` — never a hand-instantiated policy.
- A refused or failed call returns `toolRefusal(reason, error)` or
  `toolFailure(error)` from `failure.ts` — `{ success: false, error, … }`, which
  `toolCallErrored` reads to turn the chip red. Handlers never throw out of the
  tool loop (CLAUDE_ERROR_PATTERNS §15).
- Tool inputs are validated by their Zod `inputSchema`; checks that need a
  readable refusal (corpus_search's criteria) return `toolRefusal` instead of
  throwing.

## Client consumer

`hooks/api/turn-stream.ts` exposes `useTurnStream(appSessionId, model?)`, a
thin adapter over the SDK's durable `useChat({ endpoint, resume })`. It maps
the SDK's turn tree back to the flat `messages` / `toolCalls` /
`domainEvents` the chat panel renders, and parses every domain-event frame
with `parseStreamDomainEvent` (a payload that breaks the contract is logged
and dropped).

Rules:
- Do **not** consume this endpoint with `EventSource` — it is GET-only, and a
  turn starts with a POST. The SDK's `useChat` does the fetch and the parsing.
- Domain events also refresh the matching TanStack queries so the rest of the
  UI re-renders. The page clients (`constituer/client.tsx`,
  `rechercher/client.tsx`) count events by type and invalidate with a
  debounce, e.g.:

  ```ts
  const currentCount = stream.domainEvents.filter((e) => e.type === STREAM_DOMAIN_EVENT.CORPUS).length
  // … debounced:
  void qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) })
  ```

## Session resume

A user can close the tab and come back hours later.

- A turn is detached from the request: it keeps running after the tab
  closes.
- `GET /api/sessions/:sid/messages` (with the client's cursor) replays the
  server snapshot and then follows the active turn live; `useChat({ resume })`
  calls it on mount.
- `DELETE /api/sessions/:sid/messages` cancels the active turn.
- A process restart leaves no in-memory turn: the boot reaper
  (`lib/agent/runtime/reaper.ts`) marks every message still `streaming` as
  errored.
- Domain events are live-only: a reattach replays tokens and tool calls, not
  domain events, so no row may depend on one to stop spinning (see
  `subagent_event` above).

## Memory in the system prompt

Every turn's system prompt embeds the project memory of BOTH scopes: the
session's own scope in full (memory is curated, never trimmed), and the other
step's memory as a read-only section capped at `MEMORY_CROSS_SCOPE_MAX_ITEMS`
items and `MEMORY_CROSS_SCOPE_MAX_CHARS` characters for the whole rendered
block, with a tail naming how many items are not shown and the `memory_read`
call that reads them (`renderCrossScopeMemory`, `lib/agent/prompts/shared.ts`).
`memory_read` is for explicit refresh within a long session; ordinary recall
comes from the prompt.

The rendered prompt is cached on `AppSession` (`systemPrompt`, tagged with
`promptLocale` and `promptRevision`) and rebuilt when:

- **what it says changed.** Every invalidation goes through
  `SessionQueries.invalidatePrompts` / `invalidateDerivedThroughShares`, on the
  transaction of the change that made the prompt stale — both commit or
  neither does. The callers: `MemoryService` (any memory change, both
  scopes), `advanceVersion` (a corpus version moves: the corpus prompts of the
  project and of the workspaces deriving from it), ingestion (the research
  prompts that report ingest status), and `ProjectSharingService.unshare`
  (the workspaces that derived through the revoked share);
- **the locale differs** from the one it was rendered in;
- **`PROMPT_REVISION` moved** (`lib/constants.ts`). Bump it on any change to
  `lib/agent/prompts/*`; the fingerprint test
  (`lib/agent/prompts/revision.test.ts`) refuses a prompt change recorded
  without a new, sealed revision.

The cache write is a compare-and-set on `promptEpoch`, which every
invalidation bumps: a memory change that lands while a prompt renders makes
the write miss, and the prompt is re-rendered instead of an old-memory
prompt being cached as valid. Memory writes emit a `memory_event` so the
memory dialog (if open) re-renders. See [memory.md](memory.md).

## Forbidden patterns

```ts
// ❌ Returning JSON from the streaming route
return ok({ messageId })  // streaming routes never use ok<T>

// ❌ Emitting a domain event outside the contract
ctx.emit?.({ type: "fancy_event", data: {} })
// → every domain event is in lib/agent/stream-events.ts, emitted through emitDomainEvent

// ❌ Mutating the corpus directly from a route handler that wraps an agent turn
// → all mutations go through tool handlers, which call services

// ❌ Writing Message / ToolCall rows outside the persistence adapter
await prisma.toolCall.create({ data: … })
// → lib/agent/persistence/prisma-adapter.ts is the only writer

// ❌ A refusal in its own shape
return { forbidden: true, error }
// → toolRefusal(FORBIDDEN_REFUSAL, error) / toolFailure(error) from failure.ts

// ❌ Using EventSource for POST
const es = new EventSource(`/api/sessions/${sid}/messages`)
// EventSource is GET-only; use the SDK's useChat (hooks/api/turn-stream.ts)

// ❌ Translating agent output via i18n keys
const t = useTranslations("research.chat"); const text = t("answer")
// The agent's response IS the text; do not pass it through i18n
```

## Relation to other rules

- [api-routes.md](api-routes.md) documents the SSE exemption — the route
  still parses + authorizes before returning the stream.
- [api-layers.md](api-layers.md): tool handlers call services; services
  perform business logic; no handler inlines DB writes.
- [client-patterns.md](client-patterns.md): `res.ok` must be checked before
  reading `res.body`.
- [memory.md](memory.md), [citations.md](citations.md),
  [ingestion-jobs.md](ingestion-jobs.md) define the side-effect events
  produced by the matching tool handlers.
