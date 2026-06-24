/**
 * GET /api/health
 *
 * Returns the workspace health snapshot — per-lane (app / alien / bnf) status
 * derived from tool-call outcomes over the last HEALTH_WINDOW_MS. Drives the
 * tri-status indicator in the workspace header (polled every HEALTH_POLL_MS).
 *
 * Global (not project-scoped): the lanes report shared-service health, which a
 * failure affects platform-wide. Any authenticated user may read it — there is
 * no per-resource authorization (it exposes only aggregate counts, no content).
 *
 * The snapshot merges persisted tool-call outcomes with a live (cached)
 * connectivity probe of the MCP servers — see HealthService.
 */
import { withAuth } from "@/app/api/_middleware"
import { ok } from "@/lib/api-response"
import { HealthService } from "@/models/health/service"
import type { HealthSnapshot } from "@/models/health/schema"

export const GET = withAuth(async (): Promise<Response> => {
  const snapshot: HealthSnapshot = await HealthService.snapshot()
  return ok(snapshot)
})
