# Memory Rule

## Rule

**Project memory** is a small, curated, durable fact list scoped to a project.
It is **embedded in the agent's system prompt** — both scopes, see
[below](#reading-memory--the-system-prompt) — and is **not** the conversation
context.

This distinction is the most easily-confused part of the system and the most
important to keep crisp. Confusing them produces either a bloated context
window (treating memory as a chat buffer) or a forgetful agent (treating
session context as memory).

See [doc 03 — memory_item](../design/docs/03-data-model.md#memory_item) and
[doc 04 — Where memory gets written](../design/docs/04-agent-flows.md#where-memory-gets-written-both-flows).

## Memory vs. session context — the table

| | Project memory | Session context |
|---|---|---|
| Scope | One per project (with two sub-scopes: `corpus`, `research`) | One per session |
| Lifetime | Durable, lives indefinitely | Until session archive / summarization |
| Size | Tens of facts, curated | Bounded by the model's context window |
| When read | Every turn, from the system prompt (re-rendered whenever memory changes) | Continuously, while the conversation is live |
| Who writes | Agent (via `memory_write`) and user (via the memory dialog) | The conversation itself |
| Who edits | User (the memory dialog: edit, reorder, × → `MemoryService.forget`) | Nobody — the transcript is immutable |
| Shape | Sectioned items: `{ section, text, origin }` | Standard `messages[]` with `role` |
| Does it "fill up"? | **No** — facts are merged/curated | Yes — summarized when long |

If you find yourself wanting to "save the whole conversation into memory" or
"trim memory when it gets too long", you've blurred the boundary. Re-read
this table.

## Storage

```prisma
// prisma/schema.prisma
model MemoryItem {
  id        String      @id @default(uuid())
  projectId String
  scope     String      // MEMORY_SCOPE: "corpus" | "research"
  section   String      // "Périmètre du corpus", "Contraintes & filtres", …
  text      String
  origin    String?     // MEMORY_ORIGIN: "consigne" | "deduit" | "action" | "user"
  position  Int?        // ordering within section
  createdAt DateTime    @default(now())

  project   Project     @relation(fields: [projectId], references: [id])

  @@index([projectId, scope, section])
}
```

Domain enums in `models/memory/schema.ts`:

```ts
export const MEMORY_SCOPE  = { CORPUS: "corpus", RESEARCH: "research" } as const
export const MEMORY_ORIGIN = { CONSIGNE: "consigne", DEDUIT: "deduit", ACTION: "action", USER: "user" } as const
```

`section` is a free string with a curated default set (see the `memory.sections.*`
i18n keys). The agent should prefer existing section names; new sections are
allowed but must read naturally in French.

## Reading memory — the system prompt

`PromptBuilder.buildForSession` (`lib/agent/prompts/builder.ts`) renders the
memory into the system prompt; the agent does not call `memory_read` on every
turn. Each prompt carries BOTH scopes:

- the session's **own** scope, in full (`renderMemoryForPrompt`) — memory is
  curated, never trimmed;
- the **other** step's memory, read-only (`renderCrossScopeMemory`), capped at
  `MEMORY_CROSS_SCOPE_MAX_ITEMS` items and `MEMORY_CROSS_SCOPE_MAX_CHARS`
  characters for the whole rendered block (headings and tail included);
  rendering stops at the first item that does not fit, and a tail says how
  many items are not shown and which `memory_read` call reads them. This is
  how a research-scope "source à risque" reaches the corpus agent.

The rendered prompt is cached on `AppSession`, and **every memory change
invalidates the cached prompt of every session of the project, both scopes,
in the same transaction as the change** (`PromptBuilder.invalidateProject(projectId, tx)`).
The cache write is a compare-and-set on `promptEpoch`, so a prompt rendered
from memory that changed mid-render is never cached. A prompt-text change
reaches existing sessions through `PROMPT_REVISION` (see
[agent-streaming.md](agent-streaming.md#memory-in-the-system-prompt)).

The `memory_read` tool exists for **explicit refresh** within a long session
(e.g. after the agent itself called `memory_write` and wants to confirm the
new state), and to read the other scope past its prompt cap. It is *not* used
to feed memory into the prompt on every turn.

## Writing memory — agent and user

### Agent path: the `memory_write` tool

Calling the tool produces a `tool_call` row, a write through
`MemoryService.write`, and a `memory_event` SSE so the memory dialog (if open)
re-renders. It always records into the session's OWN scope.

```ts
// models/memory/service.ts — every mutation is one transaction:
// the change AND the invalidation of every session's cached prompt.
static async write(args: {
  projectId: string
  scope: MemoryScope
  section: string
  text: string
  origin?: MemoryOrigin | null   // absent → MEMORY_ORIGIN.DEDUIT (or the merged item's)
}): Promise<MemoryItem> {
  return prisma.$transaction(async (tx) => {
    // near-duplicate in the same (scope, section)? → update it; else create
    // …
    await PromptBuilder.invalidateProject(args.projectId, tx)
    return item
  })
}
```

Rules:
- **Dedupe is mandatory** ✅. Two near-identical writes merge into one item
  (its text replaced), not pile up: equal after normalisation (trim,
  lowercase, collapsed whitespace), or fewer than
  `MEMORY_NEAR_DUP_MAX_EDIT_DISTANCE` (`lib/constants.ts`) Levenshtein edits
  apart. The dialog's `createUserItem` goes through the same `write`.
- **Every mutation invalidates, atomically** ✅. `write`, `createUserItem`,
  `update`, `reorder` and `forget` each run the change and
  `invalidateProject` in one `$transaction`. `forget` returns `false` — and
  invalidates nothing — when no item matches (id, project, scope); the route
  answers 404.
- **Scopes and origins are the constants** ✅. `MemoryScope`/`MemoryOrigin`
  everywhere, and the zod schemas `memoryScopeSchema`/`memoryOriginSchema`
  (`models/memory/types.ts`) for every route and tool input — an invented
  origin is rejected, not persisted.
- Memory is small by design. If a project's memory exceeds ~50 items in a
  single scope, the **user** prunes it — the system never silently drops
  items.

### User path: the memory dialog

The dialog lists items per section, lets the user delete any (calling
`DELETE /api/projects/:id/memory/:item_id` → `MemoryService.forget`), edit
(`PUT`) and reorder (`PATCH`) them, and add a manual item (`origin: "user"`,
`POST`).

## What the agent should write

A reasonable policy (also in [doc 08](../design/docs/08-prompting.md)):

| Good (write it) | Bad (don't write it) |
|---|---|
| "Langue : français uniquement" | "L'utilisateur a dit merci" |
| "Période retenue : mai–novembre 1889" | "A cherché Le Figaro à 14h" |
| "Sources préférées : Gallica, RetroNews" | a verbatim list of search results |
| "Hypothèse : l'image unifie le récit national" | a transient phrasing of one answer |
| "Note centrale : Réception de l'inauguration" | "Note créée à 15:42" |

The corpus agent writes scope-decisions and add/remove rationales. The
research agent writes the research question, working hypotheses, and the
recurring key sources. See the per-step policies in
[doc 04](../design/docs/04-agent-flows.md).

## The system prompt slot

The shared preamble (`renderSharedPreamble`, `lib/agent/prompts/shared.ts`)
contains two slots:

```
PROJECT MEMORY (durable facts about this project, carried across all sessions —
treat as authoritative unless the user overrides):
<renderMemoryForPrompt(own scope)>

PROJECT MEMORY — OTHER STEP (READ-ONLY). …
<renderCrossScopeMemory(other scope)>
```

If a scope's memory is empty, its slot renders `(aucun élément)` — the
absence is explicit, not a void.

## SSE side-effect events

The `memory_write` tool handler emits (contract: `lib/agent/stream-events.ts`):

```ts
{ type: "memory_event", data: { kind: "write", scope, section, itemId } }
```

There is no agent forget tool, so no `forget` event; the dialog refetches
after its own DELETE.

The client reducer:
- Pushes a chat inline event ("Mémoire mise à jour · Contraintes & filtres").
- Calls `queryClient.invalidateQueries({ queryKey: memoryKeys.scope(projectId, scope) })`
  so the dialog re-renders if open.

## Onboarding "seen" state — also persisted memory, but separate model

The per-user "has seen the X intro" flag is **not** a `memory_item`. It is
its own tiny model `user_intro_seen` on the user, not on the project. It is
the answer to "should we auto-open the corpus intro on this visit?" and has
nothing to do with the corpus content.

```ts
// models/users/schema.ts
export const INTRO_KEY = { CORPUS: "corpus_intro", RESEARCH: "research_intro" } as const

// model UserIntroSeen { userId, key, seenAt }
```

A separate tiny table is right because:
- It is per-user, not per-project.
- It is a flag, not a fact.
- The user does not "edit" it — they dismiss the intro, that's the write.
- The `?` button reopens the intro **without** unsetting the flag (re-open
  is just opening the dialog with the persisted text — the auto-open
  trigger stays off).

## Forbidden patterns

```ts
// ❌ Putting the conversation transcript into memory
await MemoryService.write({ scope: "research", section: "Historique", text: lastUserMessage })

// ❌ Reading memory through the tool on every turn
const t = await tools.dispatch("memory_read", { scope: "corpus" })   // every turn
// → it is in the system prompt; use the tool only for explicit refresh

// ❌ Mutating memory without invalidating the cached prompts in the same transaction
await prisma.memoryItem.update({ where: { id }, data: { text } })
// → go through MemoryService, which invalidates inside the same $transaction

// ❌ Skipping dedupe
await prisma.memoryItem.create({ data: args })
// → must go through MemoryService.write() which checks for similar items

// ❌ Silently trimming memory when it "gets too large"
if (count > 50) await prisma.memoryItem.deleteMany({ where: ..., orderBy: { createdAt: "asc" }, take: count - 50 })
// → memory is curated by humans; never auto-prune

// ❌ Storing the intro-seen flag as a MemoryItem
await MemoryService.write({ scope: "corpus", section: "Système", text: "intro vue" })
// → use the user_intro_seen model
```

## Relation to other rules

- [agent-streaming.md](agent-streaming.md): memory is embedded in every
  turn's system prompt, which is rebuilt on any memory change;
  `memory_write` is a side-effect tool that emits a `memory_event`.
- [api-routes.md](api-routes.md): `POST /api/projects/:id/memory` and
  `DELETE /api/projects/:id/memory/:item_id` are the user-driven write/forget
  endpoints (plus `PUT`/`PATCH` for edit and reorder) — they share the scope
  and origin schemas with the `memory_write` / `memory_read` tool handlers via
  `models/memory/types.ts`.
- [models.md](models.md): `models/memory/` follows the standard five-file
  structure; `models/users/` owns the intro-seen flag.
- [i18n.md](i18n.md): the default section names and origin labels live in
  `memory.sections.*` and `memory.origin.*`.
