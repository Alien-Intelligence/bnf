// components/cards/projects/tile.tsx
// CardProjectTile — one project in the projects-list grid. Shows the name,
// optional subtitle, the head-corpus size and ingestion status, and the three
// step entry points. Dark, hairline, mono numerals per the Alien × BnF DS.

import { ArrowRight, Database } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { ROUTES } from "@/lib/constants"
import type { ProjectListItem } from "@/models/projects/schema"

interface CardProjectTileProps {
  project: ProjectListItem
}

export function CardProjectTile({ project }: CardProjectTileProps) {
  const t = useTranslations("projects")

  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        {project.subtitle && (
          <CardDescription>{project.subtitle}</CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Database className="size-3.5" strokeWidth={1.8} />
          <span className="font-mono font-medium text-foreground">
            {project.corpusSize.toLocaleString("fr-FR")}
          </span>
          {t("tile.documents")}
        </span>
        <Badge variant={project.isIngested ? "default" : "outline"}>
          {project.isIngested ? t("tile.ingested") : t("tile.notIngested")}
        </Badge>
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Link
          href={ROUTES.constituer(project.id)}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          {t("list.openCorpus")}
          <ArrowRight className="size-3.5" />
        </Link>
        <Link
          href={ROUTES.ingerer(project.id)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t("list.openIngest")}
        </Link>
        <Link
          href={ROUTES.rechercher(project.id)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t("list.openResearch")}
        </Link>
      </CardFooter>
    </Card>
  )
}
