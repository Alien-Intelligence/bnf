# Memory Rule

## Rule

**Project memory** is a small, curated, durable fact list scoped to a project.
It is **re-injected into the agent's system prompt at the start of every
session** and is **not** the conversation context.

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
| When read | Start of every session, injected into system prompt | Continuously, while the conversation is live |
| Who writes | Agent (via `memory.write`) and user (via the memory dialog) | The conversation itself |
| Who edits | User (× in the memory dialog → `memory.forget`) | Nobody — the transcript is immutable |
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

## Reading memory — at session start

`AgentService.runTurn` does **not** call `memory.read` as a tool on every
turn — it builds the system prompt with the memory snapshot at session start
(in the loop initializer; see [agent-streaming.md](agent-streaming.md)).

```ts
// lib/agent/prompts/shared.ts
export function renderMemoryForPrompt(snapshot: MemorySnapshot): string {
  return snapshot.sections.map(s => {
    const items = s.items.map(i => `- ${i.text}`).join("\n")
    return `### ${s.title}\n${items}`
  }).join("\n\n") || "(aucun élément)"
}
```

The `memory.read` tool exists for **explicit refresh** within a long session
(e.g. after the agent itself called `memory.write` and wants to confirm the
new state). It is *not* used to feed memory into the prompt on every turn.

## Writing memory — agent and user

### Agent path: `memory.write` tool

Calling the tool produces a `tool_call` row, a structured insert/upsert in
`memory_item`, and a `memory_event` SSE so the memory dialog (if open)
re-renders.

```ts
// models/memory/service.ts
static async write(args: {
  projectId: string
  scope: MemoryScope
  section: string
  text: string
  origin: MemoryOrigin
}): Promise<{ id: string; mergedInto: string | null }> {
  // Deduplicate against existing items in the same (scope, section).
  const existing = await prisma.memoryItem.findMany({
    where: { projectId: args.projectId, scope: args.scope, section: args.section },
  })
  const similar = existing.find(e => similarity(e.text, args.text) >= MEMORY_DEDUPE_SIMILARITY)
  if (similar) {
    // Update timestamp + keep the more recent origin
    await prisma.memoryItem.update({
      where: { id: similar.id },
      data: { text: chooseLonger(similar.text, args.text), origin: args.origin },
    })
    return { id: similar.id, mergedInto: similar.id }
  }
  const created = await prisma.memoryItem.create({ data: args })
  return { id: created.id, mergedInto: null }
}
```

Rules:
- **Dedupe is mandatory** ✅. Two near-identical writes ("Langue : français
  uniquement" and "Le corpus se limite au français") should merge to one
  item, not pile up. The threshold lives in `lib/constants.ts` as
  `MEMORY_DEDUPE_SIMILARITY` — start at `0.9` (cosine over normalized
  embeddings or a cheap string similarity 🔶).
- Memory is small by design. If a project's memory exceeds ~50 items in a
  single scope, the **user** prunes it — the system never silently drops
  items.

### User path: the memory dialog

The dialog lists items per section, lets the user delete any (calling
`DELETE /api/projects/:id/memory/:item_id` → `memory.forget`), and lets them
add a manual item (`origin: "user"`). Editing existing items is a delete +
re-add — there is no inline rename in v1.

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

In [doc 08](../design/docs/08-prompting.md), the preamble contains:

```
PROJECT MEMORY (durable facts about this project, carried across all sessions —
treat as authoritative unless the user overrides):
{{memory_rendered_as_sections}}
```

The `{{memory_rendered_as_sections}}` token is replaced by the output of
`renderMemoryForPrompt(snapshot)` (above). If memory is empty, the slot
renders `(aucun élément)` — the absence is explicit, not a void.

## SSE side-effect events

`memory.write` and `memory.forget` tool handlers emit:

```ts
{ type: "memory_event", data: { kind: "write"|"forget", scope, section, itemId } }
```

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

// ❌ Reading memory inside every turn instead of injecting at session start
const t = await tools.dispatch("memory.read", { scope: "corpus" })   // every turn
// → load once at session start; use the tool only for explicit refresh

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

- [agent-streaming.md](agent-streaming.md): memory is loaded once per session
  start; `memory.write` is a side-effect tool that emits a `memory_event`.
- [api-routes.md](api-routes.md): `POST /api/projects/:id/memory` and
  `DELETE /api/projects/:id/memory/:item_id` are the user-driven write/forget
  endpoints — they share validation with the `memory.write` / `memory.forget`
  tool handlers via `models/memory/types.ts`.
- [models.md](models.md): `models/memory/` follows the standard five-file
  structure; `models/users/` owns the intro-seen flag.
- [i18n.md](i18n.md): the default section names and origin labels live in
  `memory.sections.*` and `memory.origin.*`.
