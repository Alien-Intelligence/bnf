// app/api/projects/[id]/memory/route.ts
// GET  /api/projects/:id/memory?scope=corpus|research  — snapshot
// POST /api/projects/:id/memory                        — user-created fact

import { withAuth } from "@/app/api/_middleware"
import { parseBody, parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { MemoryPolicy } from "@/models/memory/policy"
import { MemoryQueries } from "@/models/memory/queries"
import { MemoryService } from "@/models/memory/service"
import { createMemoryItemSchema } from "@/models/memory/types"
import type { MemorySnapshot, MemoryItem } from "@/models/memory/schema"

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

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params
  const parsed = await parseBody(req, createMemoryItemSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("write", project)

  const item = await MemoryService.createUserItem({
    projectId: id,
    scope: parsed.scope,
    section: parsed.section,
    text: parsed.text,
  })
  return ok<MemoryItem>(item)
})
