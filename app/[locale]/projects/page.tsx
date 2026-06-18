import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireSessionUser } from "@/lib/auth-helpers"
import { prisma } from "@/lib/db"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects")
  return { title: t("title") }
}

export default async function ProjectsPage() {
  const user = await requireSessionUser("/projects")
  const t = await getTranslations("projects")

  const projects = await prisma.project.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader user={{ name: user.name, email: user.email }} />
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
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
                <Card>
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    {project.subtitle !== null && (
                      <CardDescription>{project.subtitle}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">{project.id}</p>
                  </CardContent>
                  <CardFooter className="flex gap-2">
                    <Link
                      href={`/projects/${project.id}/constituer`}
                      className={buttonVariants({ variant: "default", size: "sm" })}
                    >
                      {t("list.openCorpus")}
                    </Link>
                    <Link
                      href={`/projects/${project.id}/ingerer`}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      {t("list.openIngest")}
                    </Link>
                    <Link
                      href={`/projects/${project.id}/rechercher`}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      {t("list.openResearch")}
                    </Link>
                  </CardFooter>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
