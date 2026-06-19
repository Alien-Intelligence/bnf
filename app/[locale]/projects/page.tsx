import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects")
  return { title: t("title") }
}

export default async function ProjectsPage() {
  const user = await requireSessionUser("/projects")
  const projects = await ProjectQueries.listForOwnerWithStats(user.id)

  return (
    <ProjectsClient
      initialProjects={projects}
      user={{ name: user.name, email: user.email }}
    />
  )
}
