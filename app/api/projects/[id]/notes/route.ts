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
import { noteOcrReader, resolveCorpusProject } from "@/app/api/_corpus-source"
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
  // corpus the project reads, which is the source's when it is derived — a
  // revoked grant is a 409, never a write against an unreachable corpus.
  const corpusId = resolveCorpusProject(project)
  if (corpusId instanceof Response) return corpusId

  const { note } = await NoteService.create({
    projectId,
    corpusProjectId: corpusId,
    appSessionId: parsed.appSessionId,
    title: parsed.title,
    bodyMd: parsed.bodyMd,
  })

  // The created note already carries its citations (read in the write's own
  // transaction): no re-read after the commit, so a saved note is never
  // answered as a 500 (and retried into a duplicate). Its OCR is enriched
  // best-effort — a failed read answers check_failed inside the NoteDetail.
  return ok<NoteDetail>(await NoteService.detail(note, noteOcrReader(project, req.signal)), 201)
})
