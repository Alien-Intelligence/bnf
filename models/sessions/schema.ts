// models/sessions/schema.ts
// Domain enums and re-exported Prisma types for the AppSession model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { AppSession } from "@/lib/generated/prisma/client"

export const SESSION_SCOPE = {
  CORPUS: "corpus",
  RESEARCH: "research",
} as const
export type SessionScope = (typeof SESSION_SCOPE)[keyof typeof SESSION_SCOPE]

export const SESSION_STATUS = {
  ACTIVE: "active",
  DRAFT: "draft",
  ARCHIVED: "archived",
} as const
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS]

export type { AppSession }
