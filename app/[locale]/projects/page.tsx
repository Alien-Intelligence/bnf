import { getTranslations } from "next-intl/server"
import { requireSessionUser } from "@/lib/auth-helpers"
import { prisma } from "@/lib/db"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export default async function ProjectsPage() {
  const user = await requireSessionUser("/projects")
  const t = await getTranslations("projects")

  const projects = await prisma.project.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}/constituer`}>
                <Card className="cursor-pointer hover:ring-foreground/20 transition-shadow">
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    {project.subtitle !== null && (
                      <CardDescription>{project.subtitle}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      {project.id}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
