/**
 * GET /api/admin/ocr
 *
 * Paid-OCR (Mistral) spend + ingest volume across all projects, for the admin
 * console's OCR tab. Admin-only — flat role gate enforced inline (see
 * /api/admin/usage). Aggregation lives in IngestQueries so the CSV export
 * reuses the same numbers.
 *
 * NOTE: only paid OCR carries a tracked USD cost. The vision/describe
 * (OpenRouter) and embed (RunPod) steps record no per-call cost, so they are
 * intentionally absent here.
 *
 * Response shape: AdminOcrResponse (= AdminOcrUsage)
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden, ok } from "@/lib/api-response"
import { IngestQueries } from "@/models/ingest/queries"
import type { AdminOcrUsage } from "@/models/ingest/schema"

export type AdminOcrResponse = AdminOcrUsage

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const usage = await IngestQueries.adminOcrUsage()
  return ok<AdminOcrResponse>(usage)
})
