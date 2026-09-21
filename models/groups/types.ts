// models/groups/types.ts
// Zod schemas shared by the API routes and the react-hook-form dialogs —
// one schema per payload, never duplicated. See playbook/forms.md.

import { z } from "zod"

export const createGroupSchema = z.object({
  name: z.string().trim().min(2).max(80),
})
export type CreateGroupInput = z.infer<typeof createGroupSchema>

export const renameGroupSchema = z.object({
  name: z.string().trim().min(2).max(80),
})
export type RenameGroupInput = z.infer<typeof renameGroupSchema>

export const addMemberSchema = z.object({
  email: z.email(),
})
export type AddMemberInput = z.infer<typeof addMemberSchema>
