"use client"

// components/cards/ingest/panel.tsx
// CardIngestPanel — the single, de-geekified Ingérer surface. It answers three
// librarian questions in order — what is already consultable, what this action
// will do, what is happening now — and hides all engineering vocabulary (version
// pointers, deltas, bucket telemetry, USD budgets) behind two disclosures. It
// replaces the old summary + queue-status + come-back-later + completion +
// retry-failed cards; those states are now modes of this one panel.
//
// The `mode` is derived by the client from the active job + the delta preview.
// The raw worker queue read-model stays available, per request, under the
// in-progress "Détails" accordion (IngestQueueDetail) for debugging.
//
// Copy + structure follow the Claude Design "BnF Ingestion - Etats" handoff.

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Loader2,
  TriangleAlert,
} from "lucide-react"
import { Link } from "@/i18n/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { IngestQueueDetail } from "@/components/cards/ingest/queue-detail"
import {
  INGEST_PHASE_KEYS,
  currentPhaseIndex,
  formatEtaCompact,
} from "@/lib/ingest/stage-narrative"
import { ROUTES } from "@/lib/constants"
import { cn } from "@/lib/utils"
import type { PaidOcrEstimate } from "@/models/ingest/schema"
import type { ClusterQueueProgress } from "@/lib/cluster/contracts"

export type IngestMode =
  | "empty"
  | "pending"
  | "uptodate"
  | "running"
  | "done"
  | "failed"

interface Props {
  mode: IngestMode
  projectId: string
  /** Documents already consultable by the research assistant. */
  already: number
  delta: {
    added: number
    removed: number
    excluded: number
    excludedNoText: number
    excludedNoScan: number
    paidOcr: PaidOcrEstimate
  }
  paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
  includePaidOcr: boolean
  onTogglePaidOcr: () => void
  /** Live worker read-model while running; null in fake mode / between polls. */
  queue: ClusterQueueProgress | null
  /** Documents added by a finished run (job.addedCount) — only meaningful in
   *  the `done` mode, where every attempted doc succeeded. */
  doneCount: number
  isSubmitting: boolean
  onSubmit: () => void
  onRetry: () => void
  onCancel: () => void
}

export function CardIngestPanel({
  mode,
  projectId,
  already,
  delta,
  paidOcrBudget,
  includePaidOcr,
  onTogglePaidOcr,
  queue,
  doneCount,
  isSubmitting,
  onSubmit,
  onRetry,
  onCancel,
}: Props) {
  const t = useTranslations("ingest.panel")
  const format = useFormatter()
  const num = (n: number) => format.number(n)

  const { added, removed, excluded, excludedNoText, excludedNoScan } = delta
  const hasPaidOcr = delta.paidOcr.docCount > 0
  const showAction = mode === "empty" || mode === "pending"

  return (
    <Card>
      <CardContent className="mx-auto w-full max-w-[41.25rem] space-y-3 py-2">
        {/* Header — eyebrow + title + lead. */}
        <div>
          <div className="mono-eyebrow">{t("eyebrow")}</div>
          <h1 className="mt-1.5 text-[25px] font-semibold leading-tight tracking-tight">
            {t(`title.${mode}` as "title.empty")}
          </h1>
          <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            {t(`lead.${mode}` as "lead.empty", { added })}
          </p>
        </div>

        {/* 1 — what is already in my research. */}
        <section className="rounded-lg border bg-card px-5 py-4">
          <div className="mono-eyebrow">{t("already.eyebrow")}</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span
              className={cn(
                "text-[34px] font-semibold leading-none tracking-tight tabular-nums",
                already === 0 && "text-neutral-500",
              )}
            >
              {num(already)}
            </span>
            <span className="text-sm text-neutral-200">
              {t("already.suffix", { count: already })}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {already === 0 ? t("already.subNone") : t("already.sub")}
          </p>
        </section>

        {/* 2 — what this action will do. */}
        {showAction && (
          <section className="rounded-lg border bg-card px-5 py-4">
            <div className="mono-eyebrow">{t("action.eyebrow")}</div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="text-[34px] font-semibold leading-none tracking-tight tabular-nums text-brand-teal">
                +&nbsp;{num(added)}
              </span>
              <span className="text-sm text-neutral-200">
                {t("action.suffix", { count: added })}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {mode === "empty" ? t("action.subEmpty") : t("action.subPending")}
            </p>
            {(removed > 0 || excluded > 0) && (
              <div className="mt-3 flex flex-col gap-1.5 border-t pt-3">
                {removed > 0 && (
                  <p className="text-xs leading-relaxed text-neutral-400">
                    {t("action.removed", { count: removed })}
                  </p>
                )}
                {excluded > 0 && (
                  <p className="text-xs leading-relaxed text-neutral-400">
                    {t("action.excluded", {
                      excluded,
                      noText: excludedNoText,
                      noScan: excludedNoScan,
                    })}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* 3 — what is happening now. */}
        {mode === "running" && <RunningSection queue={queue} />}

        {/* Terminal / no-op notices. */}
        {mode === "uptodate" && (
          <Notice tone="info" title={t("uptodateNotice.title")}>
            {t("uptodateNotice.body")}
          </Notice>
        )}
        {mode === "done" && (
          <Notice tone="info" title={t("doneNotice.title", { count: doneCount })}>
            {removed > 0
              ? t("doneNotice.bodyRemoved", { count: removed })
              : t("doneNotice.body")}
          </Notice>
        )}
        {mode === "failed" && (
          <section className="rounded-lg border bg-card px-5 py-4">
            <div className="flex flex-col gap-3">
              {already > 0 && (
                <div className="flex items-start gap-2.5">
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-info"
                    strokeWidth={2}
                  />
                  <span className="text-[13px] leading-relaxed">
                    {t("failedNotice.ok")}
                  </span>
                </div>
              )}
              <div
                className={cn(
                  "flex items-start gap-2.5",
                  already > 0 && "border-t pt-3",
                )}
              >
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-warning"
                  strokeWidth={1.9}
                />
                <span className="text-[13px] leading-relaxed">
                  {t("failedNotice.fail")}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* One obvious next action. */}
        <CtaRow
          mode={mode}
          projectId={projectId}
          already={already}
          added={added}
          isSubmitting={isSubmitting}
          onSubmit={onSubmit}
          onRetry={onRetry}
          onCancel={onCancel}
        />

        {/* Demoted detail — paid OCR + technical rows. */}
        <div className="border-t">
          {hasPaidOcr && showAction && (
            <AdvancedDisclosure
              noText={excludedNoText || delta.paidOcr.docCount}
              paidOcr={delta.paidOcr}
              paidOcrBudget={paidOcrBudget}
              includePaidOcr={includePaidOcr}
              onTogglePaidOcr={onTogglePaidOcr}
            />
          )}
          <TechnicalDisclosure
            added={added}
            removed={removed}
            excluded={excluded}
            excludedNoText={excludedNoText}
            excludedNoScan={excludedNoScan}
            queue={queue}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ── "Ce qui se passe maintenant" — live phase + bar + debug accordion ─────────

function RunningSection({ queue }: { queue: ClusterQueueProgress | null }) {
  const t = useTranslations("ingest.panel")
  const [detailOpen, setDetailOpen] = useState(false)

  const total = queue?.docsTotal ?? 0
  const done = queue?.docsFinished ?? 0
  const pct = total > 0 ? Math.max(2, Math.min(100, Math.round((done / total) * 100))) : 0
  const phaseIndex = queue ? currentPhaseIndex(queue) : 0
  const eta = queue ? formatEtaCompact(queue.etaSeconds) : null
  const foliosAhead = queue?.foliosAhead ?? 0

  return (
    <section className="rounded-lg border border-brand-teal/30 bg-brand-teal/[0.06] px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="mono-eyebrow">{t("running.eyebrow")}</div>
        {queue && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {t("running.phaseStep", {
              step: phaseIndex + 1,
              total: INGEST_PHASE_KEYS.length,
            })}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2.5">
        <Loader2 className="size-4 shrink-0 animate-spin text-brand-teal" />
        <span className="text-base font-semibold">
          {queue
            ? t(`phases.${INGEST_PHASE_KEYS[phaseIndex]}` as "phases.notices")
            : t("running.generic")}
        </span>
      </div>

      {/* Progress bar — determinate when the worker reports a total, else a slim
          indeterminate shimmer so the card never looks stalled. */}
      <span className="mt-3.5 block h-1.5 overflow-hidden rounded-full bg-secondary">
        <span
          className={cn(
            "block h-full rounded-full bg-brand-teal",
            total > 0 ? "transition-[width] duration-500" : "w-1/3 animate-pulse",
          )}
          style={total > 0 ? { width: `${pct}%` } : undefined}
        />
      </span>

      {queue && (
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-neutral-200">
            {t("running.progress", { done, total })}
          </span>
          <span className="text-[13px] font-semibold text-brand-teal">
            {eta ? t("running.eta", { eta }) : t("running.etaComputing")}
          </span>
        </div>
      )}

      {foliosAhead > 0 && (
        <p className="mt-2.5 text-xs leading-relaxed text-neutral-400">
          {t("running.queueAhead", { count: foliosAhead })}
        </p>
      )}

      {/* Reassurance — the job survives a closed tab. */}
      <div className="mt-3.5 flex items-start gap-2.5 rounded-md border border-info/30 bg-info/[0.09] px-3.5 py-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.9} />
        <span className="text-[13px] font-medium leading-relaxed text-neutral-100">
          {t("running.serverNote")}
        </span>
      </div>

      {/* Debug accordion — the raw per-queue telemetry, on request. */}
      {queue && (
        <Collapsible
          open={detailOpen}
          onOpenChange={setDetailOpen}
          className="mt-3.5 border-t pt-1"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-[12.5px] font-medium text-neutral-300 transition-colors hover:text-foreground">
            <ChevronRight
              className={cn("size-3.5 transition-transform", detailOpen && "rotate-90")}
            />
            {t("running.detailsToggle")}
            <span className="flex-1" />
            <span className="font-mono text-[10.5px] text-neutral-600">
              {t("running.detailsTag")}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pb-1 pt-2">
            <IngestQueueDetail queue={queue} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}

// ── One obvious next action ───────────────────────────────────────────────────

function CtaRow({
  mode,
  projectId,
  already,
  added,
  isSubmitting,
  onSubmit,
  onRetry,
  onCancel,
}: {
  mode: IngestMode
  projectId: string
  already: number
  added: number
  isSubmitting: boolean
  onSubmit: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  const t = useTranslations("ingest.panel")
  const research = ROUTES.rechercher(projectId)

  // Each mode has exactly one primary affordance (a submit/retry button or a
  // link into Rechercher) plus an optional secondary and a one-line hint.
  const submitLabel = isSubmitting ? t("cta.submitting") : null

  switch (mode) {
    case "empty":
      return (
        <ActionShell hint={t("ctaHint.empty")}>
          <Button onClick={onSubmit} disabled={isSubmitting}>
            {submitLabel ?? t("cta.empty")}
            <ArrowRight className="size-3.5" />
          </Button>
        </ActionShell>
      )
    case "pending":
      return (
        <ActionShell hint={t("ctaHint.pending", { count: already })}>
          <Button onClick={onSubmit} disabled={isSubmitting}>
            {submitLabel ?? t("cta.pending", { count: added })}
            <ArrowRight className="size-3.5" />
          </Button>
        </ActionShell>
      )
    case "uptodate":
      return (
        <ActionShell>
          <Link href={research} className={buttonVariants()}>
            {t("cta.uptodate")}
            <ArrowRight className="size-3.5" />
          </Link>
        </ActionShell>
      )
    case "running":
      return (
        <ActionShell>
          {already > 0 && (
            <Link href={research} className={buttonVariants()}>
              {t("cta.runningConsult")}
              <ArrowRight className="size-3.5" />
            </Link>
          )}
          <Button variant="outline" onClick={onCancel}>
            {t("cta.interrupt")}
          </Button>
        </ActionShell>
      )
    case "done":
      return (
        <ActionShell>
          <Link href={research} className={buttonVariants()}>
            {t("cta.done")}
            <ArrowRight className="size-3.5" />
          </Link>
        </ActionShell>
      )
    case "failed":
      return (
        <ActionShell>
          <Button onClick={onRetry}>
            {t("cta.retry")}
            <ArrowRight className="size-3.5" />
          </Button>
          {already > 0 && (
            <Link
              href={research}
              className={buttonVariants({ variant: "outline" })}
            >
              {t("cta.toResearchAnyway")}
            </Link>
          )}
        </ActionShell>
      )
  }
}

function ActionShell({
  hint,
  children,
}: {
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

// ── Notice box (uptodate / done) ──────────────────────────────────────────────

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info"
  title: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "rounded-lg border px-5 py-4",
        tone === "info" && "border-info/35 bg-info/[0.09]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <CheckCircle2 className="size-4.5 shrink-0 text-info" strokeWidth={2} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </section>
  )
}

// ── "Options avancées" — paid OCR opt-in ──────────────────────────────────────

function AdvancedDisclosure({
  noText,
  paidOcr,
  paidOcrBudget,
  includePaidOcr,
  onTogglePaidOcr,
}: {
  noText: number
  paidOcr: PaidOcrEstimate
  paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
  includePaidOcr: boolean
  onTogglePaidOcr: () => void
}) {
  const t = useTranslations("ingest.panel")
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-3.5 text-[12.5px] font-medium text-neutral-300 transition-colors hover:text-foreground">
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {t("advanced.toggle")}
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-neutral-600">
          {t("advanced.toggleTag")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4">
        <div className="text-[13px] font-semibold">{t("advanced.title")}</div>
        <p className="mt-1.5 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
          {t("advanced.explain", { count: noText })}
        </p>
        <div className="mt-3 flex items-center gap-3.5 rounded-md border bg-card px-3.5 py-3">
          <div>
            <div className="mono-eyebrow">{t("advanced.docsLabel")}</div>
            <div className="mt-0.5 font-mono text-base font-semibold tabular-nums">
              {paidOcr.docCount}
            </div>
          </div>
          <div className="h-8 w-px self-stretch bg-border" />
          <div>
            <div className="mono-eyebrow">{t("advanced.costLabel")}</div>
            <div className="mt-0.5 font-mono text-base font-semibold text-warning tabular-nums">
              {t("advanced.cost", { cost: paidOcr.usd.toFixed(2) })}
            </div>
          </div>
          <span className="flex-1" />
          {paidOcrBudget.withinBudget ? (
            <Button
              type="button"
              size="sm"
              variant={includePaidOcr ? "default" : "outline"}
              aria-pressed={includePaidOcr}
              onClick={onTogglePaidOcr}
            >
              {includePaidOcr ? t("advanced.enabled") : t("advanced.enable")}
            </Button>
          ) : (
            <span className="text-xs font-medium text-warning">
              {t("advanced.overBudget", {
                ceiling: paidOcrBudget.ceilingUsd.toFixed(0),
              })}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-neutral-600">
          {t("advanced.footnote")}
        </p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-neutral-600">
          {t("advanced.budget", {
            spent: paidOcrBudget.spentUsd.toFixed(2),
            ceiling: paidOcrBudget.ceilingUsd.toFixed(2),
          })}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ── "Détails techniques" — static operator rows ───────────────────────────────

function TechnicalDisclosure({
  added,
  removed,
  excluded,
  excludedNoText,
  excludedNoScan,
  queue,
}: {
  added: number
  removed: number
  excluded: number
  excludedNoText: number
  excludedNoScan: number
  queue: ClusterQueueProgress | null
}) {
  const t = useTranslations("ingest.panel")
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const n = (v: number) => format.number(v)

  const rows: { k: string; v: string }[] = [
    { k: t("tech.added"), v: n(added) },
    { k: t("tech.removed"), v: n(removed) },
    {
      k: t("tech.excluded"),
      v: t("tech.excludedValue", {
        excluded,
        noText: excludedNoText,
        noScan: excludedNoScan,
      }),
    },
    { k: t("tech.phasesInternal"), v: t("tech.phasesValue") },
    { k: t("tech.target"), v: t("tech.targetValue") },
  ]
  if (queue) {
    rows.push({
      k: t("tech.processed"),
      v: t("tech.processedValue", {
        done: queue.docsFinished,
        total: queue.docsTotal,
      }),
    })
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-3.5 text-[12.5px] font-medium text-neutral-300 transition-colors hover:text-foreground">
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {t("tech.toggle")}
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-neutral-600">
          {t("tech.toggleTag")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pb-2 pt-1">
        {rows.map((r) => (
          <div
            key={r.k}
            className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-b-0"
          >
            <span className="text-xs text-muted-foreground">{r.k}</span>
            <span className="text-right font-mono text-xs text-neutral-100">{r.v}</span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
