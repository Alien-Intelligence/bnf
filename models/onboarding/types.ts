import { z } from "zod"
import { ONBOARDING_INTRO } from "./schema"

/** Body for POST /api/onboarding — shared by the route and the mutation hook. */
export const markOnboardingSeenSchema = z.object({
  intro: z.enum([ONBOARDING_INTRO.CORPUS, ONBOARDING_INTRO.RESEARCH]),
})
export type MarkOnboardingSeenInput = z.infer<typeof markOnboardingSeenSchema>
