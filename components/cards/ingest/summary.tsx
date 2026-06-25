"use client"

// components/cards/ingest/summary.tsx
// Overview card for the Ingérer step. Shows the current head version seq, the
// last ingested version seq, the delta (added / removed / excluded), and the
// CTA to start ingestion. The `sans_texte` docs are a SEPARATE, opt-in block:
// the main ingest never sends them; the librarian must deliberately include
// paid OCR, and the opt-in is disabled when the cost exceeds the project budget.

import { useTranslations } from "next-intl"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BadgeIngestStatus } from "@/components/badges/ingest/status"
import { INGEST_STATUS, type PaidOcrEstimate } from "@/models/ingest/schema"
import type { IngestJobView } from "@/models/ingest/types"

interface Props {
  headSeq: number
  ingestedSeq: number | null
  delta: {
    added: number
    removed: number
    excluded: number
    paidOcr: PaidOcrEstimate
  }
  paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
  /** Whether the librarian has opted into paid OCR for this ingestion. */
  includePaidOcr: boolean
  onTogglePaidOcr: () => void
  activeJob: IngestJobView | null
  onSubmit: () => void
  isSubmitting: boolean
}

export function CardIngestSummary({
  headSeq,
  ingestedSeq,
  delta,
  paidOcrBudget,
  includePaidOcr,
  onTogglePaidOcr,
  activeJob,
  onSubmit,
  isSubmitting,
}: Props) {
  const t = useTranslations("ingest.summary")

  const isJobActive =
    activeJob?.status === INGEST_STATUS.QUEUED ||
    activeJob?.status === INGEST_STATUS.RUNNING

  const hasPaidOcr = delta.paidOcr.docCount > 0
  const hasRegular = delta.added > 0 || delta.removed > 0
  const paidOptedIn = includePaidOcr && hasPaidOcr && paidOcrBudget.withinBudget

  // Something will actually be dispatched: a regular delta, or an in-budget
  // paid-OCR opt-in. (Paid docs alone, not opted into, are NOT a delta.)
  const submitDisabled =
    isJobActive || isSubmitting || (!hasRegular && !paidOptedIn)

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
              <span className="mono-eyebrow">{t("head")}</span>
              <span className="font-mono text-sm font-medium tabular-nums">
                v{headSeq}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="mono-eyebrow">{t("ingested")}</span>
              <span className="font-mono text-sm font-medium tabular-nums">
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

          {/* Right column: delta (regular docs only) */}
          <div className="flex flex-col gap-3">
            <span className="mono-eyebrow">{t("delta")}</span>
            <div className="flex flex-col gap-1 text-sm font-medium tabular-nums">
              <span className={delta.added > 0 ? "text-brand-teal" : ""}>
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
              {delta.excluded > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  {t("excluded", { count: delta.excluded })}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Paid-OCR opt-in — a deliberate, budget-gated choice, separate from
            the regular delta above. Never part of a normal ingest. */}
        {hasPaidOcr && (
          <div className="mt-5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="text-sm font-medium">
              {t("paidOcr", { count: delta.paidOcr.docCount })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t("paidOcrCost", { cost: delta.paidOcr.usd.toFixed(2) })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {t("paidOcrBudget", {
                spent: paidOcrBudget.spentUsd.toFixed(2),
                ceiling: paidOcrBudget.ceilingUsd.toFixed(2),
              })}
            </div>

            {paidOcrBudget.withinBudget ? (
              <Button
                type="button"
                variant={includePaidOcr ? "default" : "outline"}
                size="sm"
                className="mt-3"
                disabled={isJobActive || isSubmitting}
                aria-pressed={includePaidOcr}
                onClick={onTogglePaidOcr}
              >
                {includePaidOcr ? t("paidOcrIncluded") : t("paidOcrInclude")}
              </Button>
            ) : (
              <div className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-500">
                {t("paidOcrOverBudget", {
                  ceiling: paidOcrBudget.ceilingUsd.toFixed(2),
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <Button disabled={submitDisabled} onClick={onSubmit}>
            {isSubmitting
              ? t("submitting")
              : paidOptedIn
                ? t("submitWithOcr")
                : t("submit")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
