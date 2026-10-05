import type { PolicyUser } from "@/models/users/schema"

/**
 * The intro-seen flags are per user and self-scoped: a user marks only their
 * own (the route passes the session user's id). Explicit here, like every
 * model's authorization, rather than implied by the route.
 */
export class OnboardingPolicy {
  constructor(private user: PolicyUser) {}

  markSeen(targetUserId: string): boolean {
    return this.user.id === targetUserId
  }
}
