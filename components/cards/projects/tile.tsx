"use client"

// components/cards/projects/tile.tsx
// CardProjectTile — one project in the projects-list grid.
//
// Layout, in the order a librarian reads it:
//   header  — name, subtitle, then a meta line for provenance (who owns it,
//             whose corpus it reads) and, top-right, the owner-only actions
//   content — corpus size, ingestion state, and what the caller may do
//   footer  — navigation only: the steps this user can actually open
//
// Owner actions live in the header's CardAction slot rather than the footer:
// the footer is a step bar, and mixing "go to Ingérer" with "share this
// project" in one row both confuses the two and wraps to a second line.
//
// The steps offered follow lib/authz/project-access.ts, not the other way
// round: a read-only member sees Rechercher alone, and a derived project has
// no Constituer or Ingérer step to offer at all.

import { ArrowRight, Database, Share2, Sparkles, User } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardAction,
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
import {
  CORPUS_SOURCE_STATE,
  corpusSourceState,
  isDerived,
} from "@/lib/authz/corpus-source"
import type { ProjectListItem } from "@/models/projects/schema"

interface CardProjectTileProps {
  project: ProjectListItem
  /** The viewing user, to tell "I own this" from "I may act as an owner". */
  currentUserId: string
  onShare?: () => void
  onDerive?: () => void
}

export function CardProjectTile({
  project,
  currentUserId,
  onShare,
  onDerive,
}: CardProjectTileProps) {
  const t = useTranslations("projects")

  // Two different questions, deliberately kept apart. `isMine` is a fact about
  // the row; `mayShare` is a permission, and an admin holds it on every project
  // without owning any of them.
  const isMine = project.ownerId === currentUserId
  const mayShare = project.access === PROJECT_ACCESS_LEVEL.OWNER
  const canWrite = mayShare || project.access === PROJECT_ACCESS_LEVEL.WRITE

  const sourceState = corpusSourceState(project)
  const derived = isDerived(project)
  const revoked = sourceState === CORPUS_SOURCE_STATE.REVOKED
  // Constituer and Ingérer mutate the corpus; a derived project has none of
  // its own, and a read-only member may not touch the one it points at.
  const showCorpusSteps = canWrite && !derived

  return (
    <Card className="flex flex-col transition-colors hover:bg-accent/30">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        {project.subtitle && (
          <CardDescription>{project.subtitle}</CardDescription>
        )}

        {/* Provenance. Absent for your own ordinary project — the unmarked
            case is "mine, and it owns its corpus". */}
        {(!isMine || derived) && (
          <CardDescription className="flex flex-col gap-0.5 text-xs">
            {!isMine && (
              <span className="inline-flex items-center gap-1.5">
                <User className="size-3 shrink-0" strokeWidth={1.8} />
                {t("tile.ownedBy", { name: project.ownerName })}
              </span>
            )}
            {derived && project.corpusSourceName && (
              <span className="inline-flex items-center gap-1.5">
                <Database className="size-3 shrink-0" strokeWidth={1.8} />
                {t("tile.readsCorpus", { source: project.corpusSourceName })}
              </span>
            )}
          </CardDescription>
        )}

        {mayShare && onShare && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={onShare}
              aria-label={t("list.share")}
              title={t("list.share")}
            >
              <Share2 className="size-3.5" />
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-wrap items-center gap-2">
        {/* A revoked workspace can no longer read the corpus it points at, so
            it reports nothing about it rather than a stale count. */}
        {!revoked && (
          <>
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
          </>
        )}
        <BadgeProjectAccess access={project.access} />
        <BadgeSharedCorpus state={sourceState} />
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

        {/* Deriving needs an ingested corpus to read: without one the new
            workspace could do nothing at all. */}
        {!isMine && !derived && project.isIngested && onDerive && (
          <Button variant="ghost" size="sm" onClick={onDerive}>
            <Sparkles className="size-3.5" />
            {t("list.derive")}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
