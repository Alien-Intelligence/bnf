/**
 * GET /api/projects/:id/documents/ocr?ark=…
 *
 * The OCR quality of one corpus document: its sync status, the manifest
 * "Taux OCR" and the quality of every stored folio (feedback 2026-09-29 #7).
 * Feeds the citation side panel (folio quality) and the corpus document panel
 * (Taux OCR). No stored row yet → `status: "pending"`, never a 404.
 *
 * The quality table is global per ARK (plan D8), so the read is gated on the
 * ARK being a Document of the corpus this project reads (its source's, when
 * derived): an ARK outside that corpus is a 404 — the table is never an oracle
 * for another project's corpus. A revoked grant is the usual 409.
 *
 * Both reads are bounded (OCR_DB_TIMEOUT_MS) and tied to the request's signal.
 *
 * Authorization: read access on the project (DocumentPolicy.view).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { resolveCorpusProject } from "@/app/api/_corpus-source"
import { ok, notFound } from "@/lib/api-response"
import { withDeadline } from "@/lib/async/deadline"
import { OCR_DB_TIMEOUT_MS } from "@/lib/constants"
import { DocumentPolicy } from "@/models/documents/policy"
import { DocumentQueries } from "@/models/documents/queries"
import { toDocumentOcrView } from "@/lib/ocr/quality"
import type { DocumentOcrView } from "@/models/documents/schema"
import { documentOcrQuerySchema } from "@/models/documents/types"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, documentOcrQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(DocumentPolicy).authorize("view", project)

  const corpusId = resolveCorpusProject(project)
  if (corpusId instanceof Response) return corpusId

  const bound = { ms: OCR_DB_TIMEOUT_MS, signal: req.signal }
  const doc = await withDeadline(DocumentQueries.getByArk(corpusId, parsed.ark), {
    label: "document OCR route: corpus check",
    ...bound,
  })
  if (!doc) return notFound("Document introuvable dans ce corpus")

  const row = await withDeadline(DocumentQueries.ocrForArk(corpusId, parsed.ark), {
    label: "document OCR route: quality read",
    ...bound,
  })
  return ok<DocumentOcrView>(toDocumentOcrView(parsed.ark, row))
})
