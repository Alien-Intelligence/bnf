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

// POST /api/projects/:id/memory — user-created fact
export const createMemoryItemSchema = z.object({
  scope: z.enum(["corpus", "research"]),
  section: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(500),
})
export type CreateMemoryItemInput = z.infer<typeof createMemoryItemSchema>

// PUT /api/projects/:id/memory/:item_id — edit text or section
export const updateMemoryItemSchema = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    section: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => v.text !== undefined || v.section !== undefined, {
    message: "text or section is required",
  })
export type UpdateMemoryItemInput = z.infer<typeof updateMemoryItemSchema>

// PATCH /api/projects/:id/memory/:item_id — reorder
export const reorderMemoryItemSchema = z.object({
  position: z.number().int().min(0),
})
export type ReorderMemoryItemInput = z.infer<typeof reorderMemoryItemSchema>
