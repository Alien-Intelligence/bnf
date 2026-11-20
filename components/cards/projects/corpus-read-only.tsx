"use client"

// components/cards/projects/corpus-read-only.tsx
// What a read-only member meets on the Rechercher step of a project shared
// with them.
//
// Researching is a write — a turn creates a session and its messages
// (SessionPolicy.create, AgentPolicy.post) — so a reader cannot research inside
// the owner's project. A composer that only fails on send is a dead end, so the
// page says so and offers the way that works: a research workspace of their own
// over the same corpus (a derived project), or the one they already built.
// The carnet stays open, since reading the owner's notes is within a read grant.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DialogProjectDerive,
  type DeriveSource,
} from "@/components/dialogs/projects/derive"
import { ROUTES } from "@/lib/constants"
import type { Project } from "@/models/projects/schema"

interface CardProjectCorpusReadOnlyProps {
  /** The project being read — the source a new workspace would read from. */
  source: DeriveSource
  /** canDeriveResearchFrom for this user: false for a public, unshared project. */
  canDerive: boolean
  /** The reader's latest workspace over this corpus, when they have one. */
  existingWorkspace: Pick<Project, "id" | "name"> | null
}

export function CardProjectCorpusReadOnly({
  source,
  canDerive,
  existingWorkspace,
}: CardProjectCorpusReadOnlyProps) {
  const t = useTranslations("research.readOnly")
  const [deriving, setDeriving] = useState(false)

  return (
    <>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {t(canDerive ? "body" : "bodyNoDerive", {
              source: source.name,
              owner: source.ownerName,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {existingWorkspace ? (
            <Link
              href={ROUTES.rechercher(existingWorkspace.id)}
              className={buttonVariants()}
            >
              {t("openWorkspace", { name: existingWorkspace.name })}
            </Link>
          ) : (
            canDerive && (
              <Button onClick={() => setDeriving(true)}>{t("derive")}</Button>
            )
          )}
          <Link
            href={ROUTES.carnet(source.id)}
            className={buttonVariants({ variant: "outline" })}
          >
            {t("openCarnet")}
          </Link>
        </CardContent>
      </Card>

      {canDerive && (
        <DialogProjectDerive
          source={source}
          open={deriving}
          onOpenChange={setDeriving}
        />
      )}
    </>
  )
}
