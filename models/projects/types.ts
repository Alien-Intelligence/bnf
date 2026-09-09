import { z } from "zod"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"

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

/**
 * Granting or changing a group's access to a project. One row per
 * (project, group): re-posting with a different level is an update, not a
 * second grant. `access` is validated against PROJECT_ACCESS so a typo can
 * never reach the column — an unrecognised value grants nothing, and a silent
 * no-op grant is worse than a 400.
 */
export const shareProjectSchema = z.object({
  groupId: z.uuid(),
  access: z.enum([PROJECT_ACCESS.READ, PROJECT_ACCESS.WRITE]),
})
export type ShareProjectInput = z.infer<typeof shareProjectSchema>

/**
 * Creating a derived project — a research workspace over another project's
 * corpus. The source is identified by id; the grant that authorises it is
 * resolved server-side from the caller's group membership, never sent by the
 * client.
 */
export const createDerivedProjectSchema = z.object({
  sourceProjectId: z.uuid(),
  name: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
})
export type CreateDerivedProjectRequest = z.infer<
  typeof createDerivedProjectSchema
>
