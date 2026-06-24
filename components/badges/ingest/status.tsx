"use client"

// components/badges/ingest/status.tsx
// Renders the status of an IngestJob as a colored badge.
// Maps each status string to a Badge variant. Falls back to outline for
// unknown statuses — never throws on unexpected data from the cluster.

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { INGEST_STATUS } from "@/models/ingest/schema"

interface Props {
  status: string
}

/** Resolve the shadcn Badge variant for a given ingest status. */
function variantForStatus(
  status: string,
): "outline" | "secondary" | "destructive" | "default" {
  switch (status) {
    case INGEST_STATUS.QUEUED:
      return "outline"
    case INGEST_STATUS.RUNNING:
      return "secondary"
    case INGEST_STATUS.DONE:
      return "secondary"
    // PARTIAL = mostly succeeded, some failed → amber (styled below), not red.
    case INGEST_STATUS.PARTIAL:
      return "outline"
    case INGEST_STATUS.FAILED:
      return "destructive"
    case INGEST_STATUS.CANCELED:
      return "outline"
    default:
      return "outline"
  }
}

type KnownStatus = "queued" | "running" | "done" | "partial" | "failed" | "canceled"

const KNOWN_STATUSES: ReadonlyArray<KnownStatus> = [
  INGEST_STATUS.QUEUED,
  INGEST_STATUS.RUNNING,
  INGEST_STATUS.DONE,
  INGEST_STATUS.PARTIAL,
  INGEST_STATUS.FAILED,
  INGEST_STATUS.CANCELED,
]

export function BadgeIngestStatus({ status }: Props) {
  const t = useTranslations("ingest.status")

  // Use the i18n label when available, fall back to the raw status string
  // for unknown values that arrive from the cluster.
  const isKnown = (KNOWN_STATUSES as ReadonlyArray<string>).includes(status)
  const label = isKnown ? t(status as KnownStatus) : status

  const variant = variantForStatus(status)
  const isDone = status === INGEST_STATUS.DONE
  const isPartial = status === INGEST_STATUS.PARTIAL

  return (
    <Badge
      variant={variant}
      className={
        isDone
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
          : isPartial
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : undefined
      }
    >
      {label}
    </Badge>
  )
}
