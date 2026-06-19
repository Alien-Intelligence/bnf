// models/onboarding/schema.ts
// Per-user "has seen this intro" flag. NOT project memory — this is a per-user
// UI affordance, not a durable corpus fact (see playbook/memory.md
// "Onboarding Intro Seen State"). One row per (user, intro).

import { type UserOnboardingSeen as PrismaUserOnboardingSeen } from "@/lib/generated/prisma/client"

export type UserOnboardingSeen = PrismaUserOnboardingSeen

/** The interactive steps that carry a guided intro dialog. */
export const ONBOARDING_INTRO = {
  CORPUS: "corpus",
  RESEARCH: "research",
} as const

export type OnboardingIntro =
  (typeof ONBOARDING_INTRO)[keyof typeof ONBOARDING_INTRO]
