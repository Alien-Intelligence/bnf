// app/api/projects/[id]/memory/[item_id]/route.ts
// DELETE /api/projects/:id/memory/:item_id?scope=corpus|research  — forget
// PUT    /api/projects/:id/memory/:item_id                        — edit text/section
// PATCH  /api/projects/:id/memory/:item_id                        — reorder (position)

import { withAuth } from "@/app/api/_middleware"
import { parseBody, parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { MemoryPolicy } from "@/models/memory/policy"
import { MemoryQueries } from "@/models/memory/queries"
import { MemoryService } from "@/models/memory/service"
import { memoryQuerySchema, updateMemoryItemSchema, reorderMemoryItemSchema } from "@/models/memory/types"
import type { MemoryItem } from "@/models/memory/schema"

type RouteCtx = { params: Promise<{ id: string; item_id: string }> }

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id, item_id } = await ctx.params
  const parsed = parseQuery(req, memoryQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("forget", project)

  const deleted = await MemoryService.forget(id, parsed.scope, item_id)
  if (!deleted) return notFound("Élément introuvable")
  return ok<{ deleted: true }>({ deleted: true })
})

export const PUT = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id, item_id } = await ctx.params
  const parsed = await parseBody(req, updateMemoryItemSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("write", project)

  const existing = await MemoryQueries.get(item_id)
  if (!existing || existing.projectId !== id) return notFound("Élément introuvable")

  const item = await MemoryService.update(item_id, parsed)
  return ok<MemoryItem>(item)
})

export const PATCH = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id, item_id } = await ctx.params
  const parsed = await parseBody(req, reorderMemoryItemSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(MemoryPolicy).authorize("write", project)

  const existing = await MemoryQueries.get(item_id)
  if (!existing || existing.projectId !== id) return notFound("Élément introuvable")

  const item = await MemoryService.reorder(item_id, parsed.position)
  return ok<MemoryItem>(item)
})
