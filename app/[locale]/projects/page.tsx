import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireSessionUser } from "@/lib/auth-helpers"
import { listProjectsForUser } from "@/models/projects/service"
import { ProjectsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects")
  return { title: t("title") }
}

export default async function ProjectsPage() {
  const user = await requireSessionUser("/projects")
  const projects = await listProjectsForUser(user)

  return (
    <ProjectsClient
      initialProjects={projects}
      user={{ id: user.id, name: user.name, email: user.email }}
      isAdmin={user.role === "admin"}
    />
  )
}
