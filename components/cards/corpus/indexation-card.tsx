"use client"

// components/cards/corpus/indexation-card.tsx
// CardCorpusIndexationCard — the "Indexation" panel: one summary tile for the
// documents the search index cannot return, plus the four outcome buckets as
// clickable, proportional bars.
//
// The sibling card above it (numérisation) answers "what did we expect of these
// documents"; this one answers "what actually happened to them". A corpus can be
// 100% ingestable by class and still be missing a third of its documents because
// the ingest run shed them — until this card existed, nothing on screen said so,
// and a librarian searching the corpus got silence with no explanation.
//
// Each bucket toggles CorpusFilters.outcome, exactly like the numérisation
// buckets toggle .ingest. Data comes from CorpusSnapshot.indexation.

import { useTranslations } from "next-intl"
import { CardSharedStatBar } from "@/components/cards/shared/stat-bar"
import { CardSharedStatTile } from "@/components/cards/shared/stat-tile"
import {
  INDEXATION_OUTCOME,
  INDEXATION_OUTCOME_COLOR,
} from "@/models/documents/schema"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  indexation: CorpusSnapshot["indexation"]
  /** Currently-selected outcomes. */
  selected: string[]
  /** Toggle one outcome in/out of the filter. */
  onToggle: (outcome: string) => void
}

export function CardCorpusIndexationCard({
  indexation,
  selected,
  onToggle,
}: Props) {
  const t = useTranslations("corpus.filters.indexation")
  const { indexed, failed, excluded, notIngested } = indexation

  const unindexed = failed + excluded + notIngested
  const max = Math.max(1, indexed, failed, excluded, notIngested)
  const anySelected = selected.length > 0

  const rows = [
    {
      outcome: INDEXATION_OUTCOME.INDEXED,
      label: t("indexed"),
      sub: t("indexedSub"),
      count: indexed,
    },
    {
      outcome: INDEXATION_OUTCOME.FAILED,
      label: t("failed"),
      sub: t("failedSub"),
      count: failed,
    },
    {
      outcome: INDEXATION_OUTCOME.NOT_INGESTED,
      label: t("notIngested"),
      sub: t("notIngestedSub"),
      count: notIngested,
    },
    {
      outcome: INDEXATION_OUTCOME.EXCLUDED,
      label: t("excluded"),
      sub: t("excludedSub"),
      count: excluded,
    },
  ]

  return (
    <div className="rounded-md border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{t("title")}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {t("hint")}
        </span>
      </div>

      {/* Summary tiles: what the index can return, and what it cannot. */}
      <div className="mb-3.5 grid grid-cols-2 gap-2.5">
        <CardSharedStatTile
          label={t("searchable")}
          value={indexed}
          of={indexed + unindexed}
        />
        <CardSharedStatTile
          label={t("unindexed")}
          value={unindexed}
          tone={unindexed > 0 ? "warning" : "plain"}
        />
      </div>

      {/* Outcome bars (clickable filters) */}
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const active = selected.includes(r.outcome)
          return (
            <CardSharedStatBar
              key={r.outcome}
              label={r.label}
              sub={r.sub}
              count={r.count}
              max={max}
              color={INDEXATION_OUTCOME_COLOR[r.outcome]}
              active={active}
              dimmed={anySelected && !active}
              onClick={() => onToggle(r.outcome)}
            />
          )
        })}
      </div>
    </div>
  )
}
