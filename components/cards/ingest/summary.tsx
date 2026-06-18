"use client"

// components/cards/ingest/summary.tsx
// Overview card for the Ingérer step. Shows the current head version seq,
// the last ingested version seq (or "never ingested"), the delta (added /
// removed documents), the active-job badge, and the CTA to start ingestion.

import { useTranslations } from "next-intl"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BadgeIngestStatus } from "@/components/badges/ingest/status"
import { INGEST_STATUS } from "@/models/ingest/schema"
import type { IngestJob } from "@/models/ingest/schema"

interface Props {
  headSeq: number
  ingestedSeq: number | null
  delta: { added: number; removed: number }
  activeJob: IngestJob | null
  onSubmit: () => void
  isSubmitting: boolean
}

export function CardIngestSummary({
  headSeq,
  ingestedSeq,
  delta,
  activeJob,
  onSubmit,
  isSubmitting,
}: Props) {
  const t = useTranslations("ingest.summary")

  const isJobActive =
    activeJob?.status === INGEST_STATUS.QUEUED ||
    activeJob?.status === INGEST_STATUS.RUNNING

  const isNoDelta = delta.added === 0 && delta.removed === 0

  const submitDisabled = isJobActive || isSubmitting || isNoDelta

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{t("title")}</span>
          {activeJob && <BadgeIngestStatus status={activeJob.status} />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-6">
          {/* Left column: version state */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("head")}
              </span>
              <span className="text-sm font-medium tabular-nums">
                v{headSeq}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("ingested")}
              </span>
              <span className="text-sm font-medium tabular-nums">
                {ingestedSeq !== null ? (
                  <>v{ingestedSeq}</>
                ) : (
                  <span className="text-muted-foreground">
                    {t("neverIngested")}
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Right column: delta */}
          <div className="flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("delta")}
            </span>
            <div className="flex flex-col gap-1 text-sm font-medium tabular-nums">
              <span
                className={
                  delta.added > 0 ? "text-green-700 dark:text-green-400" : ""
                }
              >
                +{t("added", { count: delta.added })}
              </span>
              <span
                className={
                  delta.removed > 0
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                -{t("removed", { count: delta.removed })}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <Button disabled={submitDisabled} onClick={onSubmit}>
            {isSubmitting ? t("submitting") : t("submit")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
