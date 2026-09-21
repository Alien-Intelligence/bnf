"use client"

// components/cards/projects/corpus-not-ingested.tsx
// The blocking state a research workspace shows before any ingestion exists.
//
// Kept distinct from the revoked card next to it because the two invite
// different actions: an un-ingested corpus is something the owner can fix from
// « Ingérer », a revoked grant is not. Offering « Ingérer » to a reader whose
// workspace has no such step — which is what a single shared state would do —
// sends them to a page that would redirect them straight back.

import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { ROUTES } from "@/lib/constants"
import {
  CORPUS_SOURCE_STATE,
  type CorpusSourceState,
} from "@/lib/authz/corpus-source"

interface CardProjectCorpusNotIngestedProps {
  projectId: string
  /** `own` here means the caller can act on it; `shared` means they cannot. */
  sourceState: CorpusSourceState
  /** The corpus's owning project, named when this workspace is derived. */
  sourceName: string | null
}

export function CardProjectCorpusNotIngested({
  projectId,
  sourceState,
  sourceName,
}: CardProjectCorpusNotIngestedProps) {
  const t = useTranslations("research.notIngested")

  const ownsItsCorpus = sourceState === CORPUS_SOURCE_STATE.OWN

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {sourceState === CORPUS_SOURCE_STATE.SHARED
            ? t("sharedBody", { source: sourceName ?? "" })
            : t("body")}
        </CardDescription>
      </CardHeader>
      {/* Only the corpus owner can run an ingestion — a derived workspace has
          no « Ingérer » step to send the reader to. */}
      {ownsItsCorpus && (
        <CardContent>
          <Link href={ROUTES.ingerer(projectId)} className={buttonVariants()}>
            {t("openIngest")}
          </Link>
        </CardContent>
      )}
    </Card>
  )
}
