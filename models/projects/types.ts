import { z } from "zod"

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  ownerId: z.string().min(1),
})
export type CreateProjectInput = z.infer<typeof createProjectSchema>

/**
 * The shape the create form submits and the POST /api/projects route validates.
 * `ownerId` is omitted here because it is taken from the authenticated session,
 * never from the client. One schema, shared by form + route (playbook/forms).
 */
export const createProjectRequestSchema = createProjectSchema.omit({
  ownerId: true,
})
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>

export const updateProjectSchema = createProjectSchema
  .pick({ name: true, subtitle: true })
  .partial()
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
