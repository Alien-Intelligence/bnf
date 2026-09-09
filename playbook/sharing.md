# Sharing Rule

## Rule

**One function decides project access. One function resolves whose corpus to
read.** Everything else delegates.

```ts
// lib/authz/project-access.ts — who may do what
projectAccessLevel(user, project)  // → owner | write | read | none
canReadProject(user, project)
canWriteProject(user, project)
isProjectOwner(user, project)

// lib/authz/corpus-source.ts — whose corpus this project reads
corpusProjectId(project)   // → project.corpusSourceId ?? project.id
corpusSourceState(project) // → own | shared | revoked
canReachCorpus(project)
isDerived(project)
```

⛔ **Forbidden**: re-deriving either answer anywhere else. A hand-written
`project.ownerId !== user.id && !project.isPublic` in a page, or a
`ctx.projectId` passed to a corpus query in a tool handler, is the bug this
rule exists to prevent. Both were real: the first shipped in four server pages,
the second is the failure mode read-only consumption is built to avoid.

## The two grants

There is exactly one way to widen access to a project, and exactly one way to
consume another project's corpus.

```
Group ──< GroupMember >── User
  │
  └──< ProjectShare (access: read|write) >── Project (source)
                    ▲                            │
                    │                            │ corpusSourceId
                    └──── corpusSourceShareId ── Project (derived)
```

- **`ProjectShare`** — a group's grant on a project. One row per
  `(projectId, groupId)`; changing the level is an **update**, never a second
  row. `Project.isPublic` still exists and still means "readable by any
  authenticated user"; it is **not** a share and cannot be derived from.
- **`Project.corpusSourceId`** — the derived project's corpus source. A derived
  project's corpus, documents and cluster dataset are the source's; its
  sessions, memory, notes and citations are **its own**. That asymmetry is the
  feature.

## The access table

Resolution order, first match wins:

| # | Condition | Level |
|---|---|---|
| 1 | `project.ownerId === user.id` | `owner` |
| 2 | `user.role === "admin"` | `owner` |
| 3 | a `write` share on one of `user.groupIds` | `write` |
| 4 | a `read` share on one of `user.groupIds` | `read` |
| 5 | `project.isPublic` | `read` |
| 6 | — | `none` |

Rule 3 precedes rule 4 so a user in two shared groups gets the stronger grant.
An unrecognised `access` string grants **nothing** — a future migration cannot
silently widen access.

`owner` is strictly stronger than `write`. A write-shared collaborator may
mutate the corpus, run ingestion and write notes; they may **not** delete the
project or re-share it. Only an owner widens access.

## `PolicyUser`, not `User` ✅

```ts
export type PolicyUser = User & { groupIds: string[] }
```

`groupIds` is resolved **once per request** — in `withAuth` for routes, in
`requireSessionUser` for server pages — and never inside a policy. Policies do
no I/O. `bouncer()` and every `models/*/policy.ts` constructor take a
`PolicyUser`, so a policy that forgets group membership does not compile.

There is **no `before()` admin bypass**. Admin is rule 2 of the table above, in
one place instead of eleven. Policies that are not project-scoped
(`GroupPolicy`, `UserPolicy`) carry their own explicit admin check.

## `ProjectWithShares`, not `Project` ✅

```ts
static async get(id: string): Promise<ProjectWithShares | null> {
  return prisma.project.findUnique({ where: { id }, ...projectWithShares })
}
```

A `Project` loaded without its `shares` would resolve to `none` for every
shared member — a **silent denial**, the worst kind of authorization bug.
`ProjectQueries.get` is therefore the only loader an authorization path may
use, and `Bouncer.authorize` is typed against the policy method's own
parameters so passing a shares-less project is a **compile error**:

```ts
authorize<A extends keyof P & string>(action: A, ...args: PolicyArgs<P, A>): Promise<void>
```

⛔ **Forbidden**: `prisma.project.findUnique()` before an `authorize()` call.

## Derived projects — the three states

`(corpusSourceId, corpusSourceShareId)` encodes three states, and the fourth
combination is forbidden by a CHECK constraint:

| `corpusSourceId` | `corpusSourceShareId` | State | Meaning |
|---|---|---|---|
| null | null | `own` | A normal project — it owns its corpus |
| set | set | `shared` | Derived, reading the source through a live grant |
| set | **null** | `revoked` | Derived, but the grant was revoked (`onDelete: SetNull`) |

**Revocation is a state, not an absence.** ⛔ Forbidden: letting a revoked
workspace fall through to an empty corpus, an empty search result, or an empty
note list. It renders « L'accès au corpus partagé a été révoqué », the corpus
routes answer 409, and the agent tools return `CORPUS_ACCESS_REVOKED_ERROR` as
**structured output** — never a throw
([CLAUDE_ERROR_PATTERNS.md §15](../../../CLAUDE_ERROR_PATTERNS.md)).

That error is deliberately distinct from `NOT_INGESTED_ERROR`. They invite
different actions: one the researcher can take from « Ingérer », the other only
the corpus owner can. Collapsing them sends the researcher to a dead end.

## Read path ✅

Every corpus, document or RAG read resolves its target through
`corpusProjectId()`. In a route, use the one helper that yields the id and the
reachability check together, so neither can be applied without the other:

```ts
const corpusId = resolveCorpusProject(project)   // app/api/_corpus-source.ts
if (corpusId instanceof Response) return corpusId  // 409, revoked
```

In an agent tool, both facts ride the turn context — resolved once by the chat
route, never re-derived by a handler:

```ts
interface TurnScopedCtx {
  projectId: string        // notes, memory, sessions — local
  corpusProjectId: string  // corpus, documents, RAG — the source's when derived
  corpusReachable: boolean // false ⇒ the grant was revoked
}
```

```ts
const corpus = await resolveIngestedCorpus(ctx, NOT_INGESTED_ERROR)
if ("error" in corpus) return { passages: [], total: 0, error: corpus.error }
```

**What stays local**: notes, note versions, citations, project memory, sessions,
messages, tool calls, feedback, onboarding. A derived workspace's carnet is its
own and is not visible to the corpus owner.

## Write path — refused twice ✅

Both layers are required; neither alone is sufficient.

1. **Policy** — the structural condition, alongside the access check:

   ```ts
   mutate(p: ProjectWithShares) {
     return canWriteProject(this.user, p) && !isDerived(p)
   }
   ```

   In `CorpusPolicy.mutate`, `BufferPolicy.mutate`, `IngestPolicy.submit`,
   `IngestPolicy.cancel`, and `SessionPolicy.create` for `scope === "corpus"`.

2. **Tool boundary** — a derived project never owns a corpus-scope session, so
   the buffer, corpus and ingest tools are never registered for it. Constituer
   and Ingérer `redirect()` to Rechercher; the project exists and the user may
   see it, so `notFound()` would be a lie.

## Deletion

`Project.corpusSourceId` is `onDelete: Restrict`. A source cannot be deleted
while a derived project reads it — deleting it would leave that workspace's
notes citing ARKs it can no longer open. The database enforces this, so no code
path can orphan a consumer.

Deleting a **group** cascades to its memberships and its shares. The derived
workspaces built on those shares survive, in the `revoked` state.

## Concurrency

Two `write`-shared members mutating the same corpus is already safe:
`models/corpus/service.ts` takes `pg_advisory_xact_lock(hashtext('project:<id>'))`
before every `advanceVersion`, so concurrent edits interleave but the version
chain stays monotonic. No new machinery — see
[corpus-versioning.md](corpus-versioning.md).

## Checklist

- [ ] Access decided by `lib/authz/project-access.ts` — never re-derived.
- [ ] The project loaded via `ProjectQueries.get` (so `shares` is present).
- [ ] `groupIds` resolved once per request, never inside a policy.
- [ ] Corpus reads resolved through `corpusProjectId()` / `resolveCorpusProject()`.
- [ ] Notes, memory, sessions and citations left on `projectId`.
- [ ] Corpus mutations refused at both the policy and the tool boundary.
- [ ] A revoked grant renders its own state — never an empty result.
- [ ] `owner`-only actions (delete, share) use `isProjectOwner`.
