import { z } from "zod"
import { NOTE_BODY_MAX_CHARS, NOTE_TITLE_MAX_CHARS } from "./schema"

export const createNoteSchema = z.object({
  title: z.string().trim().min(1).max(NOTE_TITLE_MAX_CHARS),
  bodyMd: z.string().min(1).max(NOTE_BODY_MAX_CHARS),
  appSessionId: z.string().uuid().optional(),
})

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTE_TITLE_MAX_CHARS).optional(),
    bodyMd: z.string().max(NOTE_BODY_MAX_CHARS).optional(),
  })
  .refine((v) => v.title !== undefined || v.bodyMd !== undefined, "title or bodyMd required")

export const citationLookupSchema = z.object({
  ark: z.string().min(1),
})

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>
export type CitationLookupInput = z.infer<typeof citationLookupSchema>
