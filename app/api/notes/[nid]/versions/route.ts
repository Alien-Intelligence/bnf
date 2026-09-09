/**
 * GET /api/notes/:nid/versions
 * Returns the version history list for a note (id, seq, createdAt only).
 * Body preview is intentionally excluded to keep the list payload small.
 */
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { NotePolicy } from "@/models/notes/policy"
import { ProjectQueries } from "@/models/projects/queries"
import { NoteQueries } from "@/models/notes/queries"
import type { NoteVersionListItem } from "@/models/notes/schema"

type RouteCtx = { params: Promise<{ nid: string }> }

export const GET = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { nid } = await ctx.params

  const note = await NoteQueries.get(nid)
  if (!note) return notFound("Note introuvable")

  const project = await ProjectQueries.get(note.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("read", project)

  const versions = await NoteQueries.listVersions(nid)
  return ok<{ versions: NoteVersionListItem[] }>({ versions })
})
