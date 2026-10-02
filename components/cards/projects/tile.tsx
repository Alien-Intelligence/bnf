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
import { useLocale, useTranslations } from "next-intl"
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
import { BadgeProjectSharedCorpus } from "@/components/badges/projects/shared-corpus"
import { ROUTES, WORKSPACE_STEP } from "@/lib/constants"
import { PROJECT_RELATION } from "@/models/projects/schema"
import {
  CORPUS_SOURCE_STATE,
  corpusSourceState,
  isDerived,
} from "@/lib/authz/corpus-source"
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
  const t = useTranslations("projects.tile")
  // The footer links and the header actions are the projects-list chrome, not
  // the tile's own copy, so they keep their own scope rather than being reached
  // through a shared parent namespace.
  const tList = useTranslations("projects.list")

  // Every permission here is the server's answer (decorateProjectRows in
  // models/projects/service.ts): `relation` is "is it mine", `mayShare` is
  // ProjectPolicy.share, `steps` is workspaceStepsFor, `canDerive` is "shared
  // with me, owns its corpus, ingested". The tile recomputes none of them.
  const locale = useLocale()
  const isMine = project.relation === PROJECT_RELATION.OWN
  const sourceState = corpusSourceState(project)
  const derived = isDerived(project)
  const revoked = sourceState === CORPUS_SOURCE_STATE.REVOKED
  // Constituer and Ingérer are offered exactly when the pages would let the
  // user in.
  const showCorpusSteps = project.steps.includes(WORKSPACE_STEP.CONSTITUER)
  const mayShare = project.mayShare
  const canDerive = project.canDerive && onDerive

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
                {t("ownedBy", { name: project.ownerName })}
              </span>
            )}
            {derived && project.corpusSourceName && (
              <span className="inline-flex items-center gap-1.5">
                <Database className="size-3 shrink-0" strokeWidth={1.8} />
                {t("readsCorpus", { source: project.corpusSourceName })}
              </span>
            )}
          </CardDescription>
        )}

        {/* One secondary action, in the header rather than the step bar.
            Sharing and deriving are mutually exclusive by construction: the
            first is owner-only, the second non-owner-only. A derived workspace
            offers neither — its owner may not re-grant a corpus that is not
            theirs, and it cannot be derived from a second time. */}
        {mayShare && onShare ? (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={onShare}
              aria-label={tList("share")}
              title={tList("share")}
            >
              <Share2 className="size-3.5" />
            </Button>
          </CardAction>
        ) : (
          // Deriving needs an ingested corpus to read: without one the new
          // workspace could do nothing at all.
          canDerive && (
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDerive}
                aria-label={tList("derive")}
                title={tList("derive")}
              >
                <Sparkles className="size-3.5" />
              </Button>
            </CardAction>
          )
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
                {project.corpusSize.toLocaleString(locale)}
              </span>
              {t("documents")}
            </span>
            <Badge variant={project.isIngested ? "default" : "outline"}>
              {project.isIngested ? t("ingested") : t("notIngested")}
            </Badge>
          </>
        )}
        <BadgeProjectAccess access={project.access} />
        <BadgeProjectSharedCorpus state={sourceState} />
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        {showCorpusSteps && (
          <>
            <Link
              href={ROUTES.constituer(project.id)}
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              {tList("openCorpus")}
              <ArrowRight className="size-3.5" />
            </Link>
            <Link
              href={ROUTES.ingerer(project.id)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {tList("openIngest")}
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
          {tList("openResearch")}
          {!showCorpusSteps && <ArrowRight className="size-3.5" />}
        </Link>
      </CardFooter>
    </Card>
  )
}
