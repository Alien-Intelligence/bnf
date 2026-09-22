/**
 * GET /api/projects/:id/corpus/export
 *
 * Streams the corpus as a CSV file. Honours the same version + filter query
 * params as `GET /api/projects/:id/corpus`, so the export reflects exactly the
 * subset the comprehension panel is showing.
 *
 * Columns are stable, machine-readable snake_case (not i18n labels) — this is a
 * data export meant to be re-loaded into other tools, so it must not shift with
 * the UI locale. Mirrors the admin usage export convention.
 *
 * This route returns `text/csv`, so it is exempt from the `ok<T>()` JSON
 * envelope rule (same exemption as the SSE stream and the admin CSV export) —
 * but NOT from query validation or authorization.
 *
 * Authorization: read access on the project; admin resolves to owner — see
 * lib/authz/project-access.ts. There is no before() bypass.
 *
 * NOTE: we deliberately do NOT emit INTERMARC / interXMarc here. We only hold
 * Dublin-Core-level metadata; generating MARC from it would fabricate cataloguing
 * the BnF would (rightly) reject. Real interXMarc requires relaying the BnF's own
 * records — a separate, rate-limited job. See the corpus-export design note.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { resolveCorpusProject } from "@/app/api/_corpus-source"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusQueries } from "@/models/corpus/queries"
import { corpusFiltersSchema } from "@/models/corpus/types"
import { corpusFiltersToFilterSet } from "@/app/api/_corpus-filters"
import {
  DOCUMENT_RESOLVE_STATUS,
  classifyIngestion,
} from "@/models/documents/schema"
import { GALLICA_IIIF_VIEWER_URL, CATALOGUE_RECORD_URL } from "@/lib/constants"
import { toCsv } from "@/lib/csv"
import type { DocumentRow } from "@/models/corpus/schema"

const exportQuerySchema = corpusFiltersSchema.extend({
  version: z
    .union([
      z.literal("head"),
      z.literal("ingested"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
})


/** Stable CSV header — snake_case, locale-independent. */
const EXPORT_HEADER = [
  "ark",
  "title",
  "author",
  "year",
  "date_label",
  "doc_type",
  "lang",
  "source",
  "pages",
  "ocr_available",
  "ingestion_class",
  "resolve_status",
  "document_url",
  "iiif_manifest_url",
] as const

/** The stable external surface for a document, derived from its ARK + source. */
function documentUrl(row: DocumentRow): string {
  if (row.source === "gallica") return GALLICA_IIIF_VIEWER_URL(row.ark)
  if (row.source === "catalogue") return CATALOGUE_RECORD_URL(row.ark)
  return ""
}

/** Ingestion class is only meaningful once metadata has resolved. */
function ingestionClass(row: DocumentRow): string {
  if (row.resolveStatus !== DOCUMENT_RESOLVE_STATUS.RESOLVED) return ""
  return classifyIngestion({
    docType: row.docType,
    ocrAvailable: row.ocrAvailable,
    digitized: Boolean(row.iiifManifestUrl),
  })
}

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, exportQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  const corpusId = resolveCorpusProject(project)
  if (corpusId instanceof Response) return corpusId

  // Mirror the corpus snapshot route: build the filter set only when at least
  // one filter field is present; pass undefined otherwise.
  const filters = corpusFiltersToFilterSet(parsed)

  const versionRef = parsed.version ?? "head"
  const { versionSeq, rows } = await CorpusQueries.exportRows(
    corpusId,
    typeof versionRef === "number" ? { seq: versionRef } : versionRef,
    filters,
  )

  const csv = toCsv(
    EXPORT_HEADER,
    rows.map((r) => [
      r.ark,
      r.title,
      r.author,
      r.year,
      r.dateLabel,
      r.docType,
      r.lang,
      r.source,
      r.pages,
      r.ocrAvailable,
      ingestionClass(r),
      r.resolveStatus,
      documentUrl(r),
      r.iiifManifestUrl,
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="corpus-${projectId}-v${versionSeq}.csv"`,
      "Cache-Control": "no-store",
    },
  })
})
