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
import { INGESTION_CLASS } from "@/models/documents/schema"
import { cn } from "@/lib/utils"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  numerisation: CorpusSnapshot["numerisation"]
  /** Currently-selected ingestion classes. */
  selected: string[]
  /** Toggle one ingestion class in/out of the filter. */
  onToggle: (cls: string) => void
}

function StatBar({
  label,
  sub,
  count,
  max,
  color,
  active,
  dimmed,
  onClick,
}: {
  label: string
  sub: string
  count: number
  max: number
  color: string
  active: boolean
  dimmed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-md p-1 text-left transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dimmed && "opacity-50 hover:opacity-100",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-foreground">
          <span
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: color }}
            aria-hidden
          />
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">· {sub}</span>
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {count.toLocaleString("fr-FR")}
        </span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-secondary">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.round((count / max) * 100)}%`, background: color }}
        />
      </span>
    </button>
  )
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
      color: "var(--info)",
    },
    {
      cls: INGESTION_CLASS.VISION,
      label: t("vision"),
      sub: t("visionSub"),
      count: vision,
      color: "var(--dataset-1)",
    },
    {
      cls: INGESTION_CLASS.SANS_TEXTE,
      label: t("sansTexte"),
      sub: t("sansTexteSub"),
      count: sansTexte,
      color: "var(--warning)",
    },
    {
      cls: INGESTION_CLASS.NON_NUMERISE,
      label: t("nonNumerise"),
      sub: t("nonNumeriseSub"),
      count: nonNumerise,
      color: "var(--neutral-500)",
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
        <div className="rounded-md border px-3 py-2">
          <div className="text-[10.5px] text-muted-foreground">{t("digitized")}</div>
          <div className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums">
            {digitized.toLocaleString("fr-FR")}{" "}
            <span className="text-[11px] text-muted-foreground">
              / {resolved.toLocaleString("fr-FR")}
            </span>
          </div>
        </div>
        <div className="rounded-md border border-brand-teal/30 bg-brand-teal/5 px-3 py-2">
          <div className="text-[10.5px] text-brand-teal">{t("ingestable")}</div>
          <div className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums text-brand-teal">
            {ingestable.toLocaleString("fr-FR")}
          </div>
        </div>
      </div>

      {/* Bucket bars (clickable filters) */}
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const active = selected.includes(r.cls)
          return (
            <StatBar
              key={r.cls}
              label={r.label}
              sub={r.sub}
              count={r.count}
              max={max}
              color={r.color}
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
