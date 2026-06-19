"use client"

// components/cards/ingest/completion.tsx
// CardIngestCompletion — the success state shown when an ingest job finishes.
// Confirms the corpus is indexed and hands off to the Rechercher step.

import { ArrowRight, CheckCircle2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { buttonVariants } from "@/components/ui/button"
import { ROUTES } from "@/lib/constants"

interface Props {
  projectId: string
}

export function CardIngestCompletion({ projectId }: Props) {
  const t = useTranslations("ingest.completion")

  return (
    <Card className="border-brand-teal/25 bg-brand-teal/6">
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-teal/20 text-brand-teal">
          <CheckCircle2 className="size-6" strokeWidth={1.8} />
        </span>
        <div className="space-y-1">
          <p className="text-base font-semibold">{t("title")}</p>
          <p className="max-w-md text-sm text-muted-foreground">{t("body")}</p>
        </div>
        <Link
          href={ROUTES.rechercher(projectId)}
          className={buttonVariants()}
        >
          {t("cta")}
          <ArrowRight className="size-3.5" />
        </Link>
      </CardContent>
    </Card>
  )
}
