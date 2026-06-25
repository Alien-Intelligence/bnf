# API Layers Rule

## Rule

Every route that touches a protected resource goes through three layers in
strict order: `withAuth` injects the authenticated user and bouncer; a Policy
class makes the authorization decision; a Service class performs the business
logic. Route handlers wire these layers — they do not own any logic
themselves.

## The stack

```
Route handler                ← thin wiring, ~10 lines
  → withAuth()               ← user + bouncer, catches 401/403
      → parseBody()          ← Zod validation → 400
      → Queries              ← load resource for the policy check
      → bouncer.with(Policy).authorize("action", resource)
      → Service              ← business logic, MCP/cluster calls
      → ok<T>()              ← typed response
```

Each layer has one job. Blurring boundaries means auth ends up in services,
business logic ends up in route handlers, and authorization ends up scattered
as `if (project.ownerId !== user.id)` checks that reviewers miss.

## Layer 1 — `app/api/_middleware.ts` — `withAuth`

```ts
import { auth } from "@/lib/auth"
import { bouncer, type Bouncer, AuthorizationError } from "@/lib/bouncer"
import { unauthorized, forbidden } from "@/lib/api-response"
import type { User } from "@/models/users/schema"

type AuthedHandler<C = any> = (
  req: Request, user: User, bouncer: Bouncer, ctx: C,
) => Promise<Response>

export function withAuth<C = any>(handler: AuthedHandler<C>) {
  return async (req: Request, ctx: C) => {
    const session = await auth.api.getSession({ headers: req.headers })
    if (!session) return unauthorized()
    try {
      return await handler(req, session.user, bouncer(session.user), ctx)
    } catch (e) {
      if (e instanceof AuthorizationError) return forbidden()
      throw e
    }
  }
}
```

Rules:
- Every authenticated route uses `withAuth` — no inline `auth.getSession()`.
- `withAuth` is the only way to obtain the `user` in a route.
- `withAuth` automatically catches `AuthorizationError` and returns 403.
- The SSE route in `app/api/sessions/[sid]/messages/route.ts` uses `withAuth`
  too — it parses, authorizes, **then** returns the stream.

## Layer 2 — `lib/bouncer.ts` — `Bouncer`

Thin dispatcher that binds a policy class to a user and calls `authorize`.

```ts
export class AuthorizationError extends Error {
  constructor(message = "Forbidden") { super(message); this.name = "AuthorizationError" }
}

export interface Bouncer {
  with<P extends object>(
    PolicyClass: new (user: User) => P,
  ): { authorize(action: keyof P & string, resource?: any): Promise<void> }
}

export function bouncer(user: User): Bouncer {
  return {
    with(PolicyClass) {
      const policy = new PolicyClass(user) as any
      return {
        async authorize(action, resource) {
          if (policy.before?.(user) === true) return
          const method = policy[action]
          if (typeof method !== "function") {
            throw new AuthorizationError(`No policy method "${String(action)}"`)
          }
          const allowed = await method.call(policy, resource)
          if (!allowed) throw new AuthorizationError()
        },
      }
    },
  }
}
```

Rules:
- Policies live in `models/<model>/policy.ts`.
- Every action that touches a resource is authorized.
- Authorize **after** loading the resource, **before** calling the service.
- `create` authorizes before any DB op and receives no resource:
  `await bouncer.with(ProjectPolicy).authorize("create")`.
- `withAuth` catches `AuthorizationError`; handlers never catch it.

## Layer 3 — `models/<model>/policy.ts` — Policies

One question per method: "is this user allowed to do this to this resource?"

```ts
// models/projects/policy.ts
import type { User } from "@/models/users/schema"
import type { Project } from "./schema"

export class ProjectPolicy {
  constructor(private user: User) {}

  before(user: User): boolean | undefined {
    if (user.role === "admin") return true
    return undefined
  }

  view(p: Project): boolean { return p.ownerId === this.user.id || p.isPublic }
  create(): boolean { return this.user.role !== "guest" }
  edit(p: Project): boolean { return p.ownerId === this.user.id }
  delete(p: Project): boolean { return p.ownerId === this.user.id }
}
```

```ts
// models/corpus/policy.ts
import type { User } from "@/models/users/schema"
import type { Project } from "@/models/projects/schema"

export class CorpusPolicy {
  constructor(private user: User) {}
  before(u: User) { return u.role === "admin" ? true : undefined }
  read(project: Project): boolean { return project.ownerId === this.user.id || project.isPublic }
  mutate(project: Project): boolean { return project.ownerId === this.user.id }
}
```

Rules:
- One class per file at `models/<model>/policy.ts`.
- Methods return `boolean` — no side effects, no DB calls, no throws.
- `before()` is the admin bypass — `true` short-circuits, `undefined` falls
  through.
- Method names match the action string passed to `authorize()`.
- Policy methods take a *loaded* resource — they never fetch.

### `return true` unconditionally is a violation

A bare `return true` means "I'm trusting another layer to enforce this" — a
single point of failure. The policy is the **primary** gate; other layers are
secondary reinforcement.

If you need more context to decide (org membership, subscription state), enrich
the user in `withAuth` and pass it through `PolicyUser` — do not skip the
check. See the alien-agents playbook for the pattern; the same applies here.

## Layer 4 — `models/<model>/service.ts` — Services

All business logic: multi-step ops, MCP/cluster calls, coordinating queries
across models.

```ts
// models/corpus/service.ts
import { prisma } from "@/lib/db"
import { BnfDirectClient } from "@/lib/bnf/direct"
import { resolveAndNormalize } from "@/lib/mcp/normalize"
import { CorpusQueries } from "./queries"
import { advanceVersion } from "./versioning"
import type { Project } from "@/models/projects/schema"
import type { User } from "@/models/users/schema"
import type { AddToCorpusInput } from "./types"
import type { CorpusSnapshot } from "./schema"

export class CorpusService {
  static async addArks(
    project: Project,
    user: User,
    input: AddToCorpusInput,
  ): Promise<CorpusSnapshot> {
    const head = await CorpusQueries.headVersion(project.id)
    const existingArks = new Set(await CorpusQueries.membershipArks(head.id))
    const newArks = input.arks.filter(a => !existingArks.has(a))
    if (newArks.length === 0) return CorpusQueries.snapshot(project.id, "head")

    // Resolve and normalize new ARKs via the BnF MCP (see mcp-client.md).
    const mcp = McpClient.forUser(user)
    const documents = await resolveAndNormalize(mcp, project.id, newArks)

    return prisma.$transaction(async (tx) => {
      const next = await advanceVersion(tx, project.id, head, {
        addArks: newArks,
        createdBy: `user:${user.id}`,
        note: input.reason,
      })
      await tx.document.createMany({
        data: documents.map(d => ({ ...d, projectId: project.id })),
        skipDuplicates: true,
      })
      return CorpusQueries.snapshot(project.id, { seq: next.seq })
    })
  }
}
```

Rules:
- Services are called from route handlers only — never from client components,
  pages, or other services in a cycle.
- Services throw typed errors (not `Response` objects) — `withAuth` or the
  handler catches and maps them.
- Services may call: queries from `models/<model>/queries.ts`, the MCP client,
  the cluster client, other models' queries when non-cyclic.
- Services never import from `app/` or `components/`.
- Services are the only place that calls `lib/mcp/` and `lib/cluster/`.
- Services operate on resources already loaded by the handler for the policy
  check — they do not re-fetch what the handler already loaded.

## The resulting route handler

### Before (forbidden)
```ts
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const session = await auth.api.getSession({ headers: req.headers })
  if (!session) return unauthorized()
  const { id } = await ctx.params
  const project = await db.project.findFirst({ where: { id, ownerId: session.user.id } })
  if (!project) return notFound()
  const body = await req.json()
  const head = await db.corpusVersion.findFirst({ where: { projectId: id, isHead: true } })
  const newArks = body.arks.filter(/* ... */)
  const mcp = McpClient.forUser(session.user)
  const documents = await mcp.resolve(newArks)
  // ... 40 more lines of business logic ...
  return Response.json(snapshot)
}
```

### After (required)
```ts
export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params
  const parsed = await parseBody(req, addToCorpusSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound()
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const snapshot = await CorpusService.addArks(project, user, parsed)
  return ok<CorpusSnapshot>(snapshot)
})
```

Auth, authorization, and business logic each in exactly one place.

## Forbidden patterns

```ts
// ❌ Inline session check
const session = await auth.api.getSession({ headers: req.headers })

// ❌ Inline ownership guard
if (project.ownerId !== user.id) return forbidden()

// ❌ Ownership baked into the DB query — the policy can't see this
const project = await prisma.project.findFirst({
  where: { id, ownerId: session.user.id },
})

// ❌ MCP/cluster client called from a route handler directly
const documents = await McpClient.forUser(user).resolve(arks)

// ❌ Business logic in a route handler
const next = await advanceVersion(tx, projectId, head, ...)

// ❌ Policy method that makes a DB call
class CorpusPolicy {
  async mutate(p: Project): Promise<boolean> {
    const sub = await prisma.subscription.findFirst(...)   // NO
    return p.ownerId === this.user.id && sub?.active
  }
}

// ❌ Service that returns a Response object
class CorpusService {
  static async addArks(...): Promise<Response> { ... }   // NO
}
```

## Relation to other rules

- `parseBody` runs in the route handler before the policy check, because the
  policy may want the validated body. See [api-routes.md](api-routes.md).
- Query functions live in `models/<model>/queries.ts` per [models.md](models.md);
  the route passes the loaded resource to `authorize`, not a raw ID.
- Response helpers (`ok`, `notFound`, `unauthorized`, `forbidden`) live in
  `lib/api-response.ts` and are used only in route handlers — services never
  return `Response`.
- The SSE route does **not** skip these layers; it just doesn't end in
  `ok<T>()`. It still does parse → load → authorize → delegate to
  `AgentService.runTurn(...)`. See [agent-streaming.md](agent-streaming.md).
