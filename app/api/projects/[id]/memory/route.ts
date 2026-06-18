// app/api/projects/[id]/memory/route.ts
// GET /api/projects/:id/memory?scope=corpus|research
// Returns the MemorySnapshot for the requested scope.

import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { MemoryPolicy } from "@/models/memory/policy"
import { MemoryQueries } from "@/models/memory/queries"
import type { MemorySnapshot } from "@/models/memory/schema"

const querySchema = z.object({ scope: z.enum(["corpus", "research"]) })

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params
  const parsed = parseQuery(req, querySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("read", project)

  const snapshot = await MemoryQueries.snapshot(id, parsed.scope)
  return ok<MemorySnapshot>(snapshot)
})
