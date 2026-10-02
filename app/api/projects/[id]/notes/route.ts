/**
 * GET  /api/projects/:id/notes  — list notes for a project
 * POST /api/projects/:id/notes  — create a note in a project
 *
 * Authorization: project member (list/create).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { NotePolicy } from "@/models/notes/policy"
import { NoteQueries } from "@/models/notes/queries"
import { NoteService } from "@/models/notes/service"
import { corpusProjectId } from "@/lib/authz/corpus-source"
import { createNoteSchema } from "@/models/notes/types"
import type { NoteDetail, NoteListItem } from "@/models/notes/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("list", project)

  const notes = await NoteQueries.listForProject(projectId)
  return ok<NoteListItem[]>(notes)
})

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, createNoteSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("create", project)

  // The note belongs to this project; its citations are validated against the
  // corpus the project reads, which is the source's when it is derived.
  const { note } = await NoteService.create({
    projectId,
    corpusProjectId: corpusProjectId(project),
    appSessionId: parsed.appSessionId,
    title: parsed.title,
    bodyMd: parsed.bodyMd,
  })

  // Return the full note (citations + their folios' OCR quality) so the client
  // can prime the detail cache with the same shape GET /api/notes/:nid answers.
  const full = await NoteQueries.getDetail(note.id)
  // Deleted between the write and the re-read.
  if (!full) return notFound("Note introuvable")
  return ok<NoteDetail>(full, 201)
})
