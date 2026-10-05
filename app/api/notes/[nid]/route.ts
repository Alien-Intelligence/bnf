/**
 * GET    /api/notes/:nid  — fetch a single note with its citations and the
 *                           OCR quality of its cited folios (NoteDetail)
 * PUT    /api/notes/:nid  — update title and/or body; answers the NoteDetail
 * DELETE /api/notes/:nid  — delete note and all its citations + versions
 *
 * Authorization: read access on the project (read) / write access on it
 * (update, delete) — see lib/authz/project-access.ts. Notes belong to the
 * project that holds them, never to a shared corpus source.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { NotePolicy } from "@/models/notes/policy"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import { NoteService } from "@/models/notes/service"
import { noteOcrReader, resolveCorpusProject } from "@/app/api/_corpus-source"
import { updateNoteSchema } from "@/models/notes/types"
import type { NoteDeleted, NoteDetail } from "@/models/notes/schema"

type RouteCtx = { params: Promise<{ nid: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await ProjectQueries.get(note.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("read", project)

  // Authorized: now add the cited folios' OCR quality, read on the corpus the
  // note's citations were validated against — bounded, tied to the request,
  // and non-fatal. A revoked derived workspace keeps reading its own notes;
  // their OCR is then an explicit corpus_revoked state, never the source's rows.
  return ok<NoteDetail>(await NoteService.detail(note, noteOcrReader(project, req.signal)))
})

export const PUT = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params
  const parsed = await parseBody(req, updateNoteSchema)
  if (parsed instanceof Response) return parsed

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await ProjectQueries.get(note.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("update", project, note)

  // Citations are validated against the corpus the note's project reads —
  // the source's when that project is a derived workspace; a revoked grant is
  // a 409, never a write validated against a corpus no longer reachable.
  const corpusId = resolveCorpusProject(project)
  if (corpusId instanceof Response) return corpusId

  const updated = await NoteService.update(nid, corpusId, {
    title: parsed.title,
    bodyMd: parsed.bodyMd,
  })
  // Deleted between the authorize() above and the write.
  if (!updated) return notFound("Note introuvable")

  // The written note already carries its citations (read in the write's own
  // transaction): no re-read after the commit. Its OCR is enriched
  // best-effort — a failed read answers check_failed, never a failed update.
  return ok<NoteDetail>(await NoteService.detail(updated.note, noteOcrReader(project, req.signal)))
})

export const DELETE = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await ProjectQueries.get(note.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("delete", project, note)

  await NoteService.delete(nid)
  return ok<NoteDeleted>({ deleted: true })
})
