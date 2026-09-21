"use client"

// components/cards/projects/corpus-revoked.tsx
// The blocking state a derived workspace enters when its grant is withdrawn.
//
// Deliberately not an empty corpus and not an error: the workspace is intact,
// the notes are still readable, and only the corpus behind them is gone. That
// is why the one action offered is the carnet — the way out that still works —
// and why the source is named, since restoring access is a conversation with
// its owner, not something the reader can do from here.

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

interface CardProjectCorpusRevokedProps {
  projectId: string
  /** The project whose corpus this workspace could read, for the message. */
  sourceName: string | null
}

export function CardProjectCorpusRevoked({
  projectId,
  sourceName,
}: CardProjectCorpusRevokedProps) {
  const t = useTranslations("research.revoked")

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("body", { source: sourceName ?? "" })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href={ROUTES.carnet(projectId)}
          className={buttonVariants({ variant: "outline" })}
        >
          {t("openCarnet")}
        </Link>
      </CardContent>
    </Card>
  )
}
