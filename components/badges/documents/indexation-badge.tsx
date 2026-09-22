// components/badges/documents/indexation-badge.tsx
// Marks what became of a document at ingestion: in the index, failed, excluded
// as un-indexable, or not covered by an ingest run yet.
//
// An `indexed` document renders NOTHING. The badge is an exception marker, and
// stamping "indexé" on every row of a healthy corpus would bury the handful of
// rows that need attention — which is the whole point of showing it.
//
// The three non-indexed states are deliberately three marks, not one: "we never
// sent this, there was nothing in it to index" and "we sent this and it broke"
// are different statements to a librarian, and only the second is a problem to
// act on. The shared « non indexé » filter is what treats them as one set.

import { CircleSlash, Clock, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import {
  INDEXATION_OUTCOME,
  indexationReasonKey,
  type IndexationOutcome,
} from "@/models/documents/schema"

interface Props {
  outcome: IndexationOutcome
  /**
   * The worker's raw reason, when there is one. Rendered as the title so the
   * machine string stays reachable for a bug report without being UI copy.
   */
  reason?: string | null
  /**
   * Set when the document IS indexed but the run flagged it (a partial
   * transcription). See indexationWarning(). Rendered as a quiet mark: the
   * document is retrievable, so it must not look like a failure, but a
   * librarian judging a citation is entitled to know the text is incomplete.
   */
  warning?: string | null
}

// `labelKey` is spelled out rather than interpolating the outcome value into
// the key: the domain values are snake_case (`not_ingested`) and translation
// keys are camelCase, so using one as the other would put a snake_case key in
// the locale files and couple the copy to the enum's spelling.
const VARIANT = {
  [INDEXATION_OUTCOME.FAILED]: {
    icon: TriangleAlert,
    className: "bg-destructive/10 text-destructive",
    labelKey: "failed",
  },
  [INDEXATION_OUTCOME.EXCLUDED]: {
    icon: CircleSlash,
    className: "bg-muted text-muted-foreground",
    labelKey: "excluded",
  },
  [INDEXATION_OUTCOME.NOT_INGESTED]: {
    icon: Clock,
    className: "bg-muted text-muted-foreground",
    labelKey: "notIngested",
  },
} as const

export function BadgeDocumentIndexation({ outcome, reason, warning }: Props) {
  const t = useTranslations("corpus.documents.indexation")

  if (outcome === INDEXATION_OUTCOME.INDEXED) {
    if (!warning) return null
    const key = indexationReasonKey(warning)
    return (
      <Badge
        className="gap-1 border-0 bg-warning/10 font-normal text-warning"
        title={key ? t(`reasons.${key}`) : warning}
      >
        <TriangleAlert className="size-3 shrink-0" aria-hidden />
        {t("states.partial")}
      </Badge>
    )
  }

  const variant = VARIANT[outcome]
  const Icon = variant.icon

  // A reason we have copy for is shown; one we do not falls back to the raw
  // worker string rather than being dropped. A failure mode we cannot yet name
  // is still a failure the librarian is entitled to see.
  const reasonKey = reason ? indexationReasonKey(reason) : null
  const reasonText = reasonKey ? t(`reasons.${reasonKey}`) : reason

  return (
    <Badge
      className={`${variant.className} gap-1 border-0 font-normal`}
      title={reasonText ?? undefined}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {t(`states.${variant.labelKey}`)}
    </Badge>
  )
}
