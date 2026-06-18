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

```
models/agents/
  service.ts              — AgentService.runTurn(session, user, input)
  schema.ts               — no DB tables; types for the streamed event model
  types.ts                — Zod for the user-turn request body
  policy.ts               — SessionPolicy used by the SSE route
  queries.ts              — session resume helpers
lib/agent/
  loop.ts                 — Claude streaming loop with tool dispatch
  tools.ts                — tool registry (AGENT_TOOLS constants — see constants.md)
  dispatch.ts             — tool_name → handler mapping; handlers call services
  prompts/
    shared.ts             — preamble + memory rendering
    corpus.ts             — Step 1 prompt
    research.ts           — Step 3 prompt
lib/sse/
  emitter.ts              — typed SSE writer; handles backpressure / heartbeat
hooks/api/
  agent-stream.ts         — useAgentStream(sessionId) on the client
```

`messages/` is its own model directory for the persisted transcript; `agents/`
holds the runtime that produces it.

## The SSE event model (✅ fixed contract)

The wire format is `text/event-stream` with named events. The JSON payload
shape per event:

```ts
// models/agents/schema.ts
export type AgentEvent =
  | { type: "token";          data: { text: string } }
  | { type: "tool_call";      data: { id: string; tool: AgentToolName; input: unknown } }
  | { type: "tool_result";    data: { id: string; output: unknown; status: "ok"|"error"; latencyMs: number; error?: string } }
  | { type: "corpus_event";   data: { kind: "add"|"remove"; count: number; versionSeq: number } }
  | { type: "memory_event";   data: { kind: "write"|"forget"; scope: MemoryScope; section: string; itemId: string } }
  | { type: "note_event";     data: { kind: "created"|"updated"; noteId: string; title: string } }
  | { type: "ingest_event";   data: { kind: "submitted"; jobId: string } }
  | { type: "session_event";  data: { kind: "resumed"|"started" } }
  | { type: "done";           data: { messageId: string } }
  | { type: "error";          data: { code: string; message: string } }
```

The mapping to the prototype UI:

| Event | Renders as |
|---|---|
| `token` | Appended to the current assistant bubble |
| `tool_call` | A `BadgeToolCall` chip — "bnf.search · via MCP" |
| `tool_result` | The chip turns from spinner to ✓ or ✗ with latency |
| `corpus_event` | An inline event row — "+412 documents · v8" |
| `memory_event` | An inline event row — "Mémoire mise à jour · Périmètre" |
| `note_event` | An inline event row — "Note créée · Réception…" + a Tab opens in Atelier |
| `ingest_event` | The CTA "Ouvrir Ingérer" appears in the chat |
| `done` | Marks the assistant turn finished; flushes `message_id` for retries |
| `error` | Toast + the turn is marked failed; a Retry button appears |

## The route

```ts
// app/api/sessions/[sid]/messages/route.ts
export const POST = withAuth(async (req, user, bouncer, ctx) => {
  const { sid } = await ctx.params
  const parsed = await parseBody(req, postMessageSchema)
  if (parsed instanceof Response) return parsed

  const session = await SessionQueries.get(sid)
  if (!session) return notFound()
  await bouncer.with(SessionPolicy).authorize("post", session)

  const stream = AgentService.runTurn(session, user, parsed)
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // CF / nginx hint to disable buffering on intermediaries:
      "X-Accel-Buffering": "no",
    },
  })
})
```

`AgentService.runTurn` returns a `ReadableStream<Uint8Array>` produced by the
SSE emitter. The route handler does no streaming logic itself.

## The loop (server side)

```ts
// lib/agent/loop.ts (simplified)
export async function* runAgentLoop(args: {
  session: Session
  user: User
  userMessage: string
  tools: ToolRegistry
}): AsyncGenerator<AgentEvent> {
  const memory = await MemoryQueries.snapshot(args.session.projectId, args.session.scope)
  const history = await MessageQueries.history(args.session.id)
  const systemPrompt = buildSystemPrompt(args.session, memory)

  await MessageQueries.appendUser(args.session.id, args.userMessage)

  const claude = createClaudeStream({
    model: args.session.scope === "corpus" ? CORPUS_AGENT_MODEL : RESEARCH_AGENT_MODEL,
    system: systemPrompt,
    messages: [...history, { role: "user", content: args.userMessage }],
    tools: args.tools.toClaudeSchema(),
  })

  const assistantMsgId = await MessageQueries.beginAssistant(args.session.id)

  for await (const evt of claude) {
    if (evt.type === "content_block_delta") {
      yield { type: "token", data: { text: evt.delta.text } }
      await MessageQueries.appendAssistantToken(assistantMsgId, evt.delta.text)
      continue
    }
    if (evt.type === "tool_use") {
      const callId = evt.id
      yield { type: "tool_call", data: { id: callId, tool: evt.name, input: evt.input } }
      const started = performance.now()
      const result = await args.tools.dispatch(evt.name, evt.input, { session: args.session, user: args.user })
      const latencyMs = Math.round(performance.now() - started)
      await ToolCallQueries.insert({
        messageId: assistantMsgId, tool: evt.name, input: evt.input,
        output: result.output, status: result.status, latencyMs,
      })
      yield { type: "tool_result", data: { id: callId, ...result, latencyMs } }
      // Side-effect events the handler chose to emit (corpus, memory, note, ingest):
      for (const side of result.sideEvents ?? []) yield side
    }
  }

  await MessageQueries.finalizeAssistant(assistantMsgId)
  yield { type: "done", data: { messageId: assistantMsgId } }
}
```

Rules:
- The Claude conversation is the **source of truth for tokens and tool
  calls**. Side effects (`corpus_event`, `memory_event`, `note_event`,
  `ingest_event`) are emitted by the **tool handlers** themselves and forwarded
  through `sideEvents`.
- Every tool call writes a `tool_call` row before the result is yielded — so a
  session reload always shows the full history.
- The assistant text is persisted incrementally (`appendAssistantToken`) so
  the message survives a server crash mid-stream.
- `done` carries the persisted `message_id` — the client uses it as the cursor
  for "resume from here" if the connection drops (see SSE resume below).

## Tool dispatcher

```ts
// lib/agent/dispatch.ts
type ToolContext = { session: Session; user: User }
type ToolResult = {
  output: unknown
  status: "ok" | "error"
  error?: string
  sideEvents?: AgentEvent[]
}

export const toolHandlers: Record<AgentToolName, (input: unknown, ctx: ToolContext) => Promise<ToolResult>> = {
  [AGENT_TOOLS.CORPUS_ADD]: async (input, ctx) => {
    const parsed = addToCorpusSchema.parse(input)
    const project = await ProjectQueries.getForUser(ctx.session.projectId, ctx.user)
    new CorpusPolicy(ctx.user).mutate(project) || throwForbidden()
    const snapshot = await CorpusService.addArks(project, ctx.user, {
      ...parsed, reason: `agent:session:${ctx.session.id}`,
    })
    return {
      output: { added: snapshot.added, version: snapshot.versionSeq, total: snapshot.total },
      status: "ok",
      sideEvents: [{
        type: "corpus_event",
        data: { kind: "add", count: snapshot.added, versionSeq: snapshot.versionSeq },
      }],
    }
  },
  // ...
}
```

Rules:
- Tool handlers re-run policy checks. The session being authorized to *post*
  does not authorize every tool — a corpus mutation triggered by an agent
  still goes through `CorpusPolicy.mutate(project)`.
- Tool inputs are re-validated with their Zod schema. The model can produce
  malformed tool calls; the dispatcher must reject them with a structured
  error (`{ status: "error", error: "..." }`) that becomes a `tool_result`
  the model can react to.
- Handlers throw only on truly exceptional failures (DB down, MCP timeout).
  Validation failures and permission denials are returned as `status: "error"`
  so the agent can recover within the turn.

## Client consumer

```ts
// hooks/api/agent-stream.ts
"use client"

import { useEffect, useReducer, useRef } from "react"
import type { AgentEvent } from "@/models/agents/schema"

type StreamState = {
  inFlight: boolean
  tokens: string
  toolCalls: ToolCallChip[]
  events: InlineEvent[]
  error?: string
}

export function useAgentStream(sessionId: string) {
  const [state, dispatch] = useReducer(streamReducer, initialState)
  const sourceRef = useRef<EventSource | null>(null)

  async function send(text: string) {
    dispatch({ type: "begin" })
    const res = await apiFetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok || !res.body) {
      dispatch({ type: "error", error: `HTTP ${res.status}` })
      return
    }
    await consumeSSE(res.body, (evt: AgentEvent) => dispatch({ type: "event", evt }))
  }

  return { state, send }
}
```

Rules:
- The stream is consumed by reading `res.body` (a `ReadableStream<Uint8Array>`)
  through a small SSE parser in `lib/sse/consume.ts`. Do **not** use
  `EventSource` directly for this endpoint — `EventSource` only does `GET`,
  and we need `POST` to carry the user's message body.
- The reducer turns each event into a discriminated UI state update. The
  reducer is the single source of truth for the in-flight turn.
- Side-effect events (`corpus_event`, `note_event`) **also** invalidate the
  matching TanStack query so the rest of the UI (corpus panel, notes list)
  re-renders:

  ```ts
  case "corpus_event":
    queryClient.invalidateQueries({ queryKey: corpusKeys.all(projectId) })
    return ...
  ```

## Session resume

A user can close the tab and come back hours later. Resume restores the
session's messages and side-effect log so the UI looks the same as it did
before the disconnect.

- `GET /api/sessions/:sid/messages` returns the persisted transcript.
- A turn that was in-flight when the connection dropped has a "phantom"
  `assistant` row with `finalizedAt = null`. On resume, the client checks the
  newest assistant row; if it isn't finalized, the client offers "Reprendre
  cette réponse" which calls `POST /api/sessions/:sid/messages/resume` 🔶.
- Resume is best-effort: if the upstream Claude stream is gone, the user can
  simply re-ask.

## Memory at session boundary

At session start, `AgentService.runTurn` injects the memory snapshot into the
system prompt (the `{{memory_rendered_as_sections}}` slot in
[doc 08](../design/docs/08-prompting.md)). The agent does not call
`memory.read` for ordinary recall; the tool exists for explicit refresh after
a `memory.write` during the same long session.

Memory writes are atomic per call and emit a `memory_event` so the memory
dialog (if open) re-renders. See [memory.md](memory.md).

## Forbidden patterns

```ts
// ❌ Returning JSON from the streaming route
return ok({ messageId })  // streaming routes never use ok<T>

// ❌ Inventing a side-effect event the dispatcher doesn't know about
yield { type: "fancy_event", data: {} }  // every event type is in AgentEvent

// ❌ Mutating the corpus directly from a route handler that wraps an agent turn
// → all mutations go through tool handlers, which call services

// ❌ Skipping the tool_call log
const result = await CorpusService.addArks(...)
yield { type: "tool_result", ... }
// → ToolCallQueries.insert(...) before yielding the result

// ❌ Using EventSource for POST
const es = new EventSource(`/api/sessions/${sid}/messages`)
// EventSource is GET-only; use fetch + a streaming parser

// ❌ Translating agent output via i18n keys
const t = useTranslations("research.chat"); const text = t("answer")
// The agent's response IS the text; do not pass it through i18n
```

## Relation to other rules

- [api-routes.md](api-routes.md) documents the SSE exemption — the route
  still parses + authorizes before returning the stream.
- [api-layers.md](api-layers.md): tool handlers call services; services
  perform business logic; the loop never inlines DB writes.
- [client-patterns.md](client-patterns.md): `res.ok` must be checked before
  reading `res.body`.
- [memory.md](memory.md), [citations.md](citations.md),
  [ingestion-jobs.md](ingestion-jobs.md) define the side-effect events
  produced by the matching tool handlers.
