/**
 * GET    /api/notes/:nid  — fetch a single note with its citations
 * PUT    /api/notes/:nid  — update title and/or body
 * DELETE /api/notes/:nid  — delete note and all its citations + versions
 *
 * Authorization: project member (read) / project owner (update, delete).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { prisma } from "@/lib/db"
import { NotePolicy } from "@/models/notes/policy"
import { NoteQueries } from "@/models/notes/queries"
import { NoteService } from "@/models/notes/service"
import { updateNoteSchema } from "@/models/notes/types"
import type { NoteWithCitations } from "@/models/notes/schema"

type RouteCtx = { params: Promise<{ nid: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await prisma.project.findUnique({ where: { id: note.projectId } })
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("read", project)

  return ok<NoteWithCitations>(note)
})

export const PUT = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params
  const parsed = await parseBody(req, updateNoteSchema)
  if (parsed instanceof Response) return parsed

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await prisma.project.findUnique({ where: { id: note.projectId } })
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("update", project)

  const updated = await NoteService.update(nid, {
    title: parsed.title,
    bodyMd: parsed.bodyMd,
  })

  // Re-fetch to include fresh citations after the update.
  const full = await NoteQueries.get(updated.id)
  return ok<NoteWithCitations>(full!)
})

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await prisma.project.findUnique({ where: { id: note.projectId } })
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("delete", project)

  await NoteService.delete(nid)
  return ok<{ deleted: true }>({ deleted: true })
})
