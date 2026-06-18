import { z } from "zod"

export const createNoteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().min(1).max(200_000),
  appSessionId: z.string().uuid().optional(),
})

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    bodyMd: z.string().max(200_000).optional(),
  })
  .refine((v) => v.title !== undefined || v.bodyMd !== undefined, "title or bodyMd required")

export const citationLookupSchema = z.object({
  ark: z.string().min(1),
})

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>
export type CitationLookupInput = z.infer<typeof citationLookupSchema>
