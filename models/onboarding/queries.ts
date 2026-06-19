import "server-only"

import { prisma } from "@/lib/db"

export class OnboardingQueries {
  /** The intro keys this user has already dismissed, for system-prompt-free
   *  client gating (auto-open an intro only when its key is absent). */
  static async listSeen(userId: string): Promise<string[]> {
    const rows = await prisma.userOnboardingSeen.findMany({
      where: { userId },
      select: { intro: true },
    })
    return rows.map((r) => r.intro)
  }
}
