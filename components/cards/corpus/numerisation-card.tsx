"use client"

// components/cards/corpus/numerisation-card.tsx
// CardCorpusNumerisationCard — the "Numérisation & océrisation" panel: two
// summary tiles (Numérisés X/Y · Ingérables Z) plus the four ingestability
// buckets as clickable, proportional bars. Mirrors the prototype card
// (design/BnF Corpus Research.dc.html lines 357-387).
//
// Each bucket is a filter on the derived ingestion class — clicking toggles it
// in/out of CorpusFilters.ingest, exactly like the facet bars. Data comes from
// CorpusSnapshot.numerisation.

import { useTranslations } from "next-intl"
import { CardSharedStatBar } from "@/components/cards/shared/stat-bar"
import { CardSharedStatTile } from "@/components/cards/shared/stat-tile"
import {
  INGESTION_CLASS,
  INGESTION_CLASS_COLOR,
} from "@/models/documents/schema"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  numerisation: CorpusSnapshot["numerisation"]
  /** Currently-selected ingestion classes. */
  selected: string[]
  /** Toggle one ingestion class in/out of the filter. */
  onToggle: (cls: string) => void
}

export function CardCorpusNumerisationCard({
  numerisation,
  selected,
  onToggle,
}: Props) {
  const t = useTranslations("corpus.filters.numerisation")
  const { resolved, digitized, ingestable, ocr, vision, sansTexte, nonNumerise } =
    numerisation

  const max = Math.max(1, ocr, vision, sansTexte, nonNumerise)
  const anySelected = selected.length > 0

  const rows = [
    {
      cls: INGESTION_CLASS.OCR,
      label: t("ocr"),
      sub: t("ocrSub"),
      count: ocr,
    },
    {
      cls: INGESTION_CLASS.VISION,
      label: t("vision"),
      sub: t("visionSub"),
      count: vision,
    },
    {
      cls: INGESTION_CLASS.SANS_TEXTE,
      label: t("sansTexte"),
      sub: t("sansTexteSub"),
      count: sansTexte,
    },
    {
      cls: INGESTION_CLASS.NON_NUMERISE,
      label: t("nonNumerise"),
      sub: t("nonNumeriseSub"),
      count: nonNumerise,
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

      {/* Summary tiles */}
      <div className="mb-3.5 grid grid-cols-2 gap-2.5">
        <CardSharedStatTile
          label={t("digitized")}
          value={digitized}
          of={resolved}
        />
        <CardSharedStatTile
          label={t("ingestable")}
          value={ingestable}
          tone="brand"
        />
      </div>

      {/* Bucket bars (clickable filters) */}
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const active = selected.includes(r.cls)
          return (
            <CardSharedStatBar
              key={r.cls}
              label={r.label}
              sub={r.sub}
              count={r.count}
              max={max}
              color={INGESTION_CLASS_COLOR[r.cls]}
              active={active}
              dimmed={anySelected && !active}
              onClick={() => onToggle(r.cls)}
            />
          )
        })}
      </div>
    </div>
  )
}
