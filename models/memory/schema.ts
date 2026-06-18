// models/memory/schema.ts
// Domain enums and re-exported Prisma types for the MemoryItem model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { MemoryItem } from "@/lib/generated/prisma/client"

export const MEMORY_SCOPE = {
  CORPUS: "corpus",
  RESEARCH: "research",
} as const
export type MemoryScope = (typeof MEMORY_SCOPE)[keyof typeof MEMORY_SCOPE]

export const MEMORY_ORIGIN = {
  CONSIGNE: "consigne",
  DEDUIT: "deduit",
  ACTION: "action",
  USER: "user",
} as const
export type MemoryOrigin = (typeof MEMORY_ORIGIN)[keyof typeof MEMORY_ORIGIN]

export type { MemoryItem }
