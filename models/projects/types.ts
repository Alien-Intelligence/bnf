import { z } from "zod"

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  ownerId: z.string().min(1),
})
export type CreateProjectInput = z.infer<typeof createProjectSchema>

export const updateProjectSchema = createProjectSchema
  .pick({ name: true, subtitle: true })
  .partial()
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
