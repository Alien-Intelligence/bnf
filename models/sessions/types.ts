// models/sessions/types.ts
// Zod schemas for session request validation and their inferred TypeScript types.
// These are shared by route handlers, hooks, and forms — single source of truth.

import { z } from "zod"

export const createSessionSchema = z.object({
  scope: z.enum(["corpus", "research"]),
  // Optional: the rail's "+" creates an unnamed session (placeholder title set
  // server-side) that the first message auto-names. See SessionService.create.
  title: z.string().trim().min(1).max(100).optional(),
})
export type CreateSessionInput = z.infer<typeof createSessionSchema>

export const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(100),
})
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>

export const listSessionsQuerySchema = z.object({
  scope: z.enum(["corpus", "research"]),
})
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>
