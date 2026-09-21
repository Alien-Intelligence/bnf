import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { bouncer } from "@/lib/bouncer"
import { ProjectPolicy } from "@/models/projects/policy"
import { listAllProjects } from "@/models/projects/service"
import { ROUTES } from "@/lib/constants"
import { AdminProjectsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.projects")
  return { title: t("title") }
}

/**
 * Org-wide project oversight — the honest home for "show me everything".
 *
 * It exists because 0.17.0 put this on the *user-facing* projects list instead,
 * where every project an admin did not own appeared under « Partagés avec moi »
 * and claimed a share that had never happened. Listing them all is a console
 * question; it is asked here, under a heading that says so.
 *
 * Access is gated twice: app/[locale]/admin/layout.tsx runs requireAdminUser
 * for every tab, and ProjectPolicy.listAll is authorized here so the check
 * travels with the data rather than relying on the layout alone.
 */
export default async function AdminProjectsPage() {
  const user = await requireAdminUser(ROUTES.adminProjects)
  await bouncer(user).with(ProjectPolicy).authorize("listAll")

  const projects = await listAllProjects(user)

  return (
    <AdminProjectsClient initialProjects={projects} currentUserId={user.id} />
  )
}
