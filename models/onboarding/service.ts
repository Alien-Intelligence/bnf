import "server-only"

import { prisma } from "@/lib/db"
import type { OnboardingIntro } from "./schema"

export class OnboardingService {
  /**
   * Records that a user has seen an intro. Idempotent: re-opening the intro via
   * the "?" button and re-dismissing it is a no-op upsert, never an error.
   */
  static async markSeen(
    userId: string,
    intro: OnboardingIntro,
  ): Promise<void> {
    await prisma.userOnboardingSeen.upsert({
      where: { userId_intro: { userId, intro } },
      create: { userId, intro },
      update: {},
    })
  }
}
