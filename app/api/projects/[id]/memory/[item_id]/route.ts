// app/api/projects/[id]/memory/[item_id]/route.ts
// DELETE /api/projects/:id/memory/:item_id?scope=corpus|research
// Removes a single memory item from the project's memory.

import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { MemoryPolicy } from "@/models/memory/policy"
import { MemoryService } from "@/models/memory/service"

const querySchema = z.object({ scope: z.enum(["corpus", "research"]) })

type RouteCtx = { params: Promise<{ id: string; item_id: string }> }

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id, item_id } = await ctx.params
  const parsed = parseQuery(req, querySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("forget", project)

  await MemoryService.forget(id, parsed.scope, item_id)
  return ok<{ deleted: true }>({ deleted: true })
})
