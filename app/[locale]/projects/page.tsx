import { ROUTES } from "@/lib/constants"
import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireSessionUser } from "@/lib/auth-helpers"
import { listProjectsForUser } from "@/models/projects/service"
import { workspaceHeaderViewer } from "@/lib/authz/workspace-header"
import { ProjectsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects")
  return { title: t("title") }
}

export default async function ProjectsPage() {
  const user = await requireSessionUser(ROUTES.projects)
  const projects = await listProjectsForUser(user)

  return (
    <ProjectsClient
      initialProjects={projects}
      viewer={workspaceHeaderViewer(user)}
    />
  )
}
