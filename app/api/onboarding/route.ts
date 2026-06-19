/**
 * POST /api/onboarding  — record that the authenticated user has seen an intro.
 *
 * Self-scoped: a user can only mark their own onboarding flags (the row is
 * keyed by the session user id), so there is no resource to authorize beyond
 * the withAuth session check.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok } from "@/lib/api-response"
import { OnboardingService } from "@/models/onboarding/service"
import { markOnboardingSeenSchema } from "@/models/onboarding/types"

export const POST = withAuth(async (req, user) => {
  const parsed = await parseBody(req, markOnboardingSeenSchema)
  if (parsed instanceof Response) return parsed

  await OnboardingService.markSeen(user.id, parsed.intro)
  return ok<{ ok: true }>({ ok: true })
})
