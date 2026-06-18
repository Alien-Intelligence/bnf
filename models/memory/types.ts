import { z } from "zod"

export const memoryWriteSchema = z.object({
  scope: z.enum(["corpus", "research"]),
  section: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(500),
  origin: z.enum(["consigne", "deduit", "action", "user"]).optional(),
})
export type MemoryWriteInput = z.infer<typeof memoryWriteSchema>

export const memoryQuerySchema = z.object({
  scope: z.enum(["corpus", "research"]),
})
export type MemoryQueryInput = z.infer<typeof memoryQuerySchema>
