"use client"

// components/dialogs/buffer/index.tsx
// DialogBuffer — the research buffer ("tampon") as a dialog opened from the
// CardBufferBox pill at the bottom of the sessions rail (next to project
// memory). The tampon is the VISIBLE, verifiable staging area: search stages ARK
// candidates (agent corpus_search / manual buffer_add), the librarian sees them
// accumulate here, curates (discard / clear), then commits the set to the
// versioned corpus. Self-fetches via useBuffer; the Constituer client invalidates
// the buffer query on buffer_event and on turn-finish so it never goes stale.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, ArrowRight, Layers, Trash2, X } from "lucide-react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useBuffer,
  useCommitBuffer,
  useClearBuffer,
  useDiscardCandidates,
} from "@/hooks/api/buffer"
import { BUFFER_PANEL_LIMIT } from "@/lib/constants"
import type { BufferRow } from "@/models/buffer/schema"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
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

export function DialogBuffer({ open, onOpenChange, projectId }: Props) {
  const t = useTranslations("corpus.buffer")
  const tCommon = useTranslations("common")
  const { data, isLoading, isError, refetch } = useBuffer(
    projectId,
    {},
    { limit: BUFFER_PANEL_LIMIT },
  )
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

  const isBusy = commit.isPending || clear.isPending

  const subtitle =
    total === 0
      ? t("emptyHint")
      : `${t("subtitle")}${range ? ` · ${range}` : ""}${
          topTypes.length > 0
            ? ` · ${topTypes.map(([code, n]) => `${code} (${n})`).join(", ")}`
            : ""
        }`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-8 tracking-tight">
            <Layers className="size-4 shrink-0 text-brand-teal" aria-hidden />
            <span>{t("title")}</span>
            <Badge variant="secondary">{t("count", { count: total })}</Badge>
          </DialogTitle>
          <DialogDescription className="max-w-[62ch] text-xs leading-relaxed">
            {subtitle}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto px-3 py-3">
          {isLoading && (
            <div className="space-y-2 px-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}

          {isError && (
            <div className="flex flex-col items-center gap-3 py-8 text-destructive">
              <AlertCircle className="size-5" />
              <p className="text-sm">{t("error")}</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                {tCommon("tryAgain")}
              </Button>
            </div>
          )}

          {!isLoading && !isError && data && total === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          )}

          {!isLoading && !isError && data && total > 0 && (
            <>
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
            </>
          )}
        </div>

        {/* Footer: commit / clear (with an inline confirm to avoid a nested dialog). */}
        <div className="flex items-center gap-2 border-t bg-muted/40 px-5 py-3">
          {confirmClear ? (
            <>
              <span className="flex-1 text-xs text-muted-foreground">
                {t("clearConfirmBody", { count: total })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmClear(false)}
              >
                {t("clearConfirmCancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={clear.isPending}
                onClick={() => clear.mutate(undefined, { onSettled: () => setConfirmClear(false) })}
              >
                {clear.isPending ? t("clearing") : t("clearConfirmOk")}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                disabled={isBusy || total === 0}
                onClick={() => commit.mutate({ reason: t("commitReason") })}
              >
                <ArrowRight />
                {commit.isPending ? t("committing") : t("commit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy || total === 0}
                onClick={() => setConfirmClear(true)}
                title={t("clear")}
                aria-label={t("clear")}
              >
                <Trash2 />
              </Button>
              <DialogClose render={<Button type="button" size="sm" variant="ghost" />}>
                {tCommon("close")}
              </DialogClose>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
