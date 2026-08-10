"use client"

// components/cards/buffer/panel.tsx
// The research buffer ("tampon") panel in Constituer: the VISIBLE, verifiable
// staging area. Search stages ARK candidates here (via the agent's corpus_search
// or manual buffer_add); the librarian sees them accumulate, curates, and then
// commits the set to the versioned corpus. Self-fetches via useBuffer and
// live-refreshes when the client invalidates on a buffer_event.
//
// Rendered nothing when the buffer is empty (no clutter until candidates exist).

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { X, ArrowRight, Trash2 } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  useBuffer,
  useCommitBuffer,
  useClearBuffer,
  useDiscardCandidates,
} from "@/hooks/api/buffer"
import { BUFFER_PANEL_LIMIT } from "@/lib/constants"
import type { BufferRow } from "@/models/buffer/schema"

interface Props {
  projectId: string
}

/** "1880s – 1890s" (or a single decade, or null) from period facet keys. */
function periodRange(period: Record<string, number>): string | null {
  const keys = Object.keys(period)
  if (keys.length === 0) return null
  const sorted = [...keys].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first} – ${last}`
}

export function CardBufferPanel({ projectId }: Props) {
  const t = useTranslations("corpus.buffer")
  const { data, isLoading, isError } = useBuffer(projectId, {}, { limit: BUFFER_PANEL_LIMIT })
  const commit = useCommitBuffer(projectId)
  const clear = useClearBuffer(projectId)
  const discard = useDiscardCandidates(projectId)
  const [confirmClear, setConfirmClear] = useState(false)

  const total = data?.total ?? 0
  const range = useMemo(() => (data ? periodRange(data.facets.period) : null), [data])
  const topTypes = useMemo(() => {
    if (!data) return [] as [string, number][]
    return Object.entries(data.facets.type)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
  }, [data])

  // Hide the panel entirely until the buffer holds something — it is transient
  // scratch, not a permanent fixture of the workspace.
  if (!isLoading && !isError && total === 0) return null

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    )
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("error")}</p>
        </CardContent>
      </Card>
    )
  }

  const isBusy = commit.isPending || clear.isPending

  return (
    <Card className="border-brand-teal/30">
      <CardHeader className="gap-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">{t("title")}</CardTitle>
          <Badge variant="secondary">{t("count", { count: total })}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("subtitle")}
          {range ? ` · ${range}` : ""}
          {topTypes.length > 0
            ? ` · ${topTypes.map(([code, n]) => `${code} (${n})`).join(", ")}`
            : ""}
        </p>
      </CardHeader>

      <CardContent className="max-h-64 space-y-1 overflow-auto p-3 pt-0">
        {data.sample.map((row) => (
          <CandidateRow
            key={row.id}
            row={row}
            noTitle={t("noTitle")}
            discardLabel={t("discard")}
            disabled={isBusy || discard.isPending}
            onDiscard={() => discard.mutate({ arks: [row.ark] })}
          />
        ))}
        {total > data.sample.length ? (
          <p className="pt-1 text-center text-xs text-muted-foreground">
            {t("more", { count: total - data.sample.length })}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="gap-2">
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={isBusy}
          onClick={() => commit.mutate({ reason: t("commitReason") })}
        >
          <ArrowRight />
          {commit.isPending ? t("committing") : t("commit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => setConfirmClear(true)}
          title={t("clear")}
          aria-label={t("clear")}
        >
          <Trash2 />
        </Button>
      </CardFooter>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clearConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("clearConfirmBody", { count: total })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClear(false)}>
              {t("clearConfirmCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, { onSettled: () => setConfirmClear(false) })
              }
            >
              {clear.isPending ? t("clearing") : t("clearConfirmOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

interface RowProps {
  row: BufferRow
  noTitle: string
  discardLabel: string
  disabled: boolean
  onDiscard: () => void
}

function CandidateRow({ row, noTitle, discardLabel, disabled, onDiscard }: RowProps) {
  const meta = [row.year?.toString(), row.docType].filter(Boolean).join(" · ")
  return (
    <div className="group flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <p className="truncate">{row.title ?? noTitle}</p>
        {meta ? <p className="truncate text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onDiscard}
        title={discardLabel}
        aria-label={discardLabel}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100 disabled:pointer-events-none"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
