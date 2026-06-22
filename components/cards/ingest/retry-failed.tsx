"use client"

// components/cards/ingest/retry-failed.tsx
// CardIngestRetryFailed — shown when an ingest job finished with per-doc
// failures (status "failed", not "done"). Offers a one-click re-queue of just
// the failed ARKs via IngestService.retryFailed. The pointer was deliberately
// NOT advanced for such a job, so a successful retry completes the version.

import { AlertTriangle, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface Props {
  error: string | null
  onRetry: () => void
  isRetrying: boolean
}

export function CardIngestRetryFailed({ error, onRetry, isRetrying }: Props) {
  const t = useTranslations("ingest.retry")

  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="flex flex-col gap-3 py-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertTriangle className="size-5" strokeWidth={1.8} />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("title")}</p>
            <p className="text-sm text-muted-foreground">
              {error ?? t("body")}
            </p>
          </div>
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RotateCw className="size-3.5" />
            {t("button")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
