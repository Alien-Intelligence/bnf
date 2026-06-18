# API Routes Rule

## Rule

Every internal API route validates its inputs, returns an explicitly typed
response, and uses the shared helpers from `lib/api-response.ts` and
`models/<model>/types.ts`. No exceptions.

The agent SSE streams (`POST /api/sessions/:sid/messages`) are exempt from
the `ok<T>()` rule because they return a `text/event-stream` response — but
they still validate the request body with `parseBody`. See
[agent-streaming.md](agent-streaming.md).

## Structure

```
app/api/projects/route.ts                              GET (list) + POST (create)
app/api/projects/[id]/route.ts                         GET + PUT + DELETE
app/api/projects/[id]/corpus/route.ts                  GET (snapshot)
app/api/projects/[id]/corpus/add/route.ts              POST
app/api/projects/[id]/corpus/remove/route.ts           POST
app/api/projects/[id]/corpus/diff/route.ts             GET
app/api/projects/[id]/sessions/route.ts                GET (list) + POST (create)
app/api/sessions/[sid]/messages/route.ts               GET (history) + POST (user turn, SSE)
app/api/projects/[id]/notes/route.ts                   GET + POST
app/api/notes/[nid]/route.ts                           GET + PUT + DELETE
app/api/projects/[id]/memory/route.ts                  GET + POST
app/api/projects/[id]/memory/[item_id]/route.ts        DELETE
app/api/projects/[id]/ingest/route.ts                  POST (submit)
app/api/ingest/[job_id]/route.ts                       GET (status)
```

This mirrors the surface in [doc 05](../design/docs/05-app-api-and-agent-tools.md).

## Validation — every route, no exceptions

Request bodies use `parseBody(req, schema)` from `app/api/_helpers.ts`. Query
params use Zod before use. `req.json()` is never called directly.

```ts
const parsed = await parseBody(request, addToCorpusSchema)
if (parsed instanceof Response) return parsed
const body = parsed   // fully typed
```

Schemas live in `models/<model>/types.ts` (see [models.md](models.md)). The
route handler imports them — the schema is never duplicated.

## Return types — every route explicitly typed

Response types are exported from `models/<model>/types.ts` (Zod-inferred
inputs) or `models/<model>/schema.ts` (Prisma `GetPayload` for DB rows). The
route uses `ok<ResponseType>(data)` from `@/lib/api-response.ts`.

```ts
export function ok<T>(data: T, init?: number | ResponseInit): Response
```

Error helpers: `badRequest`, `notFound`, `unauthorized`, `forbidden`,
`conflict`, `unprocessable` — all return `{ error: string, issues?: unknown }`.

## Complete pattern — `app/api/projects/[id]/corpus/add/route.ts`

```ts
// models/corpus/types.ts
import { z } from "zod"
export const arkSchema = z.string().regex(/^ark:\/\d+\/[A-Za-z0-9]+$/, "invalid ARK")
export const addToCorpusSchema = z.object({
  arks: z.array(arkSchema).min(1).max(5_000),
  reason: z.string().trim().min(1).max(300),
})
export type AddToCorpusInput = z.infer<typeof addToCorpusSchema>
```

```ts
// app/api/projects/[id]/corpus/add/route.ts
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { addToCorpusSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService } from "@/models/corpus/service"
import { ProjectQueries } from "@/models/projects/queries"
import type { CorpusSnapshot } from "@/models/corpus/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, addToCorpusSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const snapshot = await CorpusService.addArks(project, user, parsed)
  return ok<CorpusSnapshot>(snapshot)
})
```

The handler is ~10 lines: parse, load, authorize, delegate, respond. All
business logic lives in `CorpusService.addArks` (see [api-layers.md](api-layers.md)).

## Streaming routes — `text/event-stream`

`POST /api/sessions/:sid/messages` does not return JSON. It returns an SSE
stream and is exempt from `ok<T>()` — but **not** from `parseBody` or
authorization.

```ts
// app/api/sessions/[sid]/messages/route.ts
export const POST = withAuth(async (req, user, bouncer, ctx) => {
  const { sid } = await ctx.params
  const parsed = await parseBody(req, postMessageSchema)
  if (parsed instanceof Response) return parsed

  const session = await SessionQueries.get(sid)
  if (!session) return notFound()
  await bouncer.with(SessionPolicy).authorize("post", session)

  const stream = AgentService.runTurn(session, user, parsed)   // ReadableStream
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
})
```

The event vocabulary is defined in [agent-streaming.md](agent-streaming.md).

## Forbidden patterns

```ts
// ❌ req.json() without parseBody — no validation
const body = await req.json()
const { arks } = body

// ❌ Response.json() / NextResponse.json() — inconsistent envelope
return Response.json({ ok: true })
return NextResponse.json(snapshot, { status: 201 })

// ❌ Route handler with no typed response
export const POST = withAuth(async (req, user, bouncer) => {
  // ...
  return ok(snapshot)   // ← TS can't verify the hook's expected shape
})

// ❌ Schema duplicated between route and form
const schema = z.object({ arks: z.array(z.string()) })   // route
const schema = z.object({ arks: z.array(z.string()) })   // form
// → single source in models/corpus/types.ts

// ❌ Inline session check — only withAuth provides the user
const session = await auth.getSession({ headers: req.headers })

// ❌ Inline ownership guard — authorization belongs in a policy
if (project.ownerId !== user.id) return forbidden()
```

## Relation to other rules

- `parseBody` is the enforcement point for the ban on unvalidated inputs.
- Response types from `models/<model>/types.ts` and `schema.ts` are the single
  source of truth; hooks import them, never redefine them.
- Routes call `models/<model>/queries.ts` for reads and `service.ts` for
  writes — never construct Prisma queries inline.
- The `ok`/`notFound`/`unauthorized`/`forbidden` helpers in
  `lib/api-response.ts` are the only way to build a JSON response.
- The SSE exemption is documented inline in
  `app/api/sessions/[sid]/messages/route.ts`.
