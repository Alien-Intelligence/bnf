"use client"

// components/cards/projects/tile.tsx
// CardProjectTile — one project in the projects-list grid. Shows the name,
// optional subtitle, the head-corpus size and ingestion status, the caller's
// access level, and the step entry points they can actually use. Dark,
// hairline, mono numerals per the Alien × BnF DS.
//
// The steps offered follow lib/authz/project-access.ts, not the other way
// round: a read-only member sees Rechercher alone, and a derived project has
// no Constituer or Ingérer step to offer at all.

import { ArrowRight, Database, Share2, Sparkles, User } from "lucide-react"
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
import { Button, buttonVariants } from "@/components/ui/button"
import { BadgeProjectAccess } from "@/components/badges/projects/access"
import { BadgeSharedCorpus } from "@/components/badges/projects/shared-corpus"
import { ROUTES } from "@/lib/constants"
import { PROJECT_ACCESS_LEVEL } from "@/lib/authz/project-access"
import { corpusSourceState, isDerived } from "@/lib/authz/corpus-source"
import type { ProjectListItem } from "@/models/projects/schema"

interface CardProjectTileProps {
  project: ProjectListItem
  onShare?: () => void
  onDerive?: () => void
}

export function CardProjectTile({
  project,
  onShare,
  onDerive,
}: CardProjectTileProps) {
  const t = useTranslations("projects")

  const isOwner = project.access === PROJECT_ACCESS_LEVEL.OWNER
  const canWrite = isOwner || project.access === PROJECT_ACCESS_LEVEL.WRITE
  const derived = isDerived(project)
  // Constituer and Ingérer mutate the corpus; a derived project has none of
  // its own, and a read-only member may not touch the one it points at.
  const showCorpusSteps = canWrite && !derived

  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        {project.subtitle && (
          <CardDescription>{project.subtitle}</CardDescription>
        )}
        {!isOwner && (
          <CardDescription className="inline-flex items-center gap-1.5">
            <User className="size-3.5" strokeWidth={1.8} />
            {t("tile.ownedBy", { name: project.ownerName })}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-wrap items-center gap-2">
        {!derived && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Database className="size-3.5" strokeWidth={1.8} />
            <span className="font-mono font-medium text-foreground">
              {project.corpusSize.toLocaleString("fr-FR")}
            </span>
            {t("tile.documents")}
          </span>
        )}
        {!derived && (
          <Badge variant={project.isIngested ? "default" : "outline"}>
            {project.isIngested ? t("tile.ingested") : t("tile.notIngested")}
          </Badge>
        )}
        <BadgeProjectAccess access={project.access} />
        <BadgeSharedCorpus
          state={corpusSourceState(project)}
          sourceName={project.corpusSourceName ?? ""}
        />
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        {showCorpusSteps && (
          <>
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
          </>
        )}
        <Link
          href={ROUTES.rechercher(project.id)}
          className={buttonVariants({
            variant: showCorpusSteps ? "outline" : "default",
            size: "sm",
          })}
        >
          {t("list.openResearch")}
          {!showCorpusSteps && <ArrowRight className="size-3.5" />}
        </Link>

        {isOwner && onShare && (
          <Button variant="ghost" size="sm" onClick={onShare}>
            <Share2 className="size-3.5" />
            {t("list.share")}
          </Button>
        )}
        {/* Deriving needs an ingested corpus to read: without one the new
            workspace could do nothing at all. */}
        {!isOwner && !derived && project.isIngested && onDerive && (
          <Button variant="ghost" size="sm" onClick={onDerive}>
            <Sparkles className="size-3.5" />
            {t("list.derive")}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
