/**
 * GET /api/admin/projects
 *
 * Every project in the instance, for the admin console's Projects tab. The
 * user-facing `GET /api/projects` deliberately answers a narrower question —
 * own + real shares — so an admin's home screen is theirs and not the whole
 * table (see playbook/sharing.md, "May I open it" is not "is it mine").
 *
 * Authorized through `ProjectPolicy.listAll` rather than the inline
 * `user.role !== "admin"` the sibling admin routes use: the policy already
 * exists for this decision, and a role comparison in a handler is the thing
 * api-layers.md forbids.
 *
 * Response shape: ProjectListItem[]
 */
import { withAuth } from "@/app/api/_middleware"
import { ok } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { listAllProjects } from "@/models/projects/service"
import type { ProjectListItem } from "@/models/projects/schema"

export const GET = withAuth(async (_req, user, bouncer) => {
  await bouncer.with(ProjectPolicy).authorize("listAll")

  return ok<ProjectListItem[]>(await listAllProjects(user))
})
