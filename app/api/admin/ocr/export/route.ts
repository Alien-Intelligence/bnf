/**
 * GET /api/admin/ocr/export
 *
 * Streams a CSV of paid-OCR jobs (project, cost, docs, status, timing).
 * Admin-only — same flat role gate and same aggregation as /api/admin/ocr.
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden } from "@/lib/api-response"
import { toCsv } from "@/lib/csv"
import { IngestQueries } from "@/models/ingest/queries"

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const usage = await IngestQueries.adminOcrUsage(10_000)

  const csv = toCsv(
    [
      "job_id",
      "project_id",
      "project_name",
      "status",
      "created_at",
      "finished_at",
      "paid_ocr_docs",
      "estimated_usd",
      "actual_usd",
      "chunks_written",
    ],
    usage.recentJobs.map((j) => [
      j.id,
      j.projectId,
      j.projectName,
      j.status,
      j.createdAt,
      j.finishedAt ?? "",
      j.paidOcrDocs,
      j.estimatedUsd ?? "",
      j.actualUsd ?? "",
      j.chunksWritten ?? "",
    ]),
  )

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ocr.csv"',
      "Cache-Control": "no-store",
    },
  })
})
