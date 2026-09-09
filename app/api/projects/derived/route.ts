/**
 * POST /api/projects/derived — create a research workspace over another
 * project's corpus.
 *
 * A distinct route because authorization is two-sided: the caller must be able
 * to read the *source* (CorpusPolicy.read) and to create a project of their own
 * (ProjectPolicy.create). Neither check alone is sufficient.
 *
 * The grant that authorises the derivation is resolved server-side from the
 * caller's group membership and recorded on the new project, so a later
 * revocation is visible rather than silent.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound, unprocessable } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { CorpusPolicy } from "@/models/corpus/policy"
import { ProjectQueries } from "@/models/projects/queries"
import {
  NoCorpusGrantError,
  ProjectService,
  SourceIsDerivedError,
  SourceNotIngestedError,
} from "@/models/projects/service"
import { createDerivedProjectSchema } from "@/models/projects/types"
import type { Project } from "@/models/projects/schema"

export const POST = withAuth(async (req, user, bouncer) => {
  const parsed = await parseBody(req, createDerivedProjectSchema)
  if (parsed instanceof Response) return parsed

  const source = await ProjectQueries.get(parsed.sourceProjectId)
  if (!source) return notFound("Projet source introuvable")

  await bouncer.with(CorpusPolicy).authorize("read", source)
  await bouncer.with(ProjectPolicy).authorize("create")

  try {
    const project = await ProjectService.createDerived({
      source,
      user,
      name: parsed.name,
      subtitle: parsed.subtitle,
    })
    return ok<Project>(project, 201)
  } catch (e) {
    // Each of these is a fact about the source the caller can act on — a
    // never-ingested corpus, no grant, an already-derived project — not a
    // server fault. Say which.
    if (
      e instanceof NoCorpusGrantError ||
      e instanceof SourceNotIngestedError ||
      e instanceof SourceIsDerivedError
    ) {
      return unprocessable(e.message)
    }
    throw e
  }
})
