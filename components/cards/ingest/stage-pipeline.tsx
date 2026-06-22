"use client"

// components/cards/ingest/stage-pipeline.tsx
// Four-row pipeline card showing the four ingest stages (extract / chunk /
// embed / index). Each row is always rendered — no loading/empty state —
// because the pipeline always exists once a job exists. Stage state is
// derived from job.stage + job.status, never from poll-based guessing.
// See playbook/ui-states.md §Ingestion.

import { useTranslations } from "next-intl"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Check, Loader2, Minus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { INGEST_STATUS, INGEST_STAGE } from "@/models/ingest/schema"
import type { IngestJob } from "@/models/ingest/schema"

// The canonical stage order. The index determines the ordinal comparison.
const STAGE_ORDER = [
  INGEST_STAGE.EXTRACT,
  INGEST_STAGE.CHUNK,
  INGEST_STAGE.EMBED,
  INGEST_STAGE.INDEX,
] as const

type StageState = "pending" | "running" | "done" | "failed" | "skipped"

interface StageInfo {
  stage: string
  state: StageState
  /** 0–100 progress percentage, only meaningful when state === "running" */
  progress: number
}

/**
 * Per-doc state counters the worker reports in every progress event and the
 * server persists into `ingest_job.stats`. Each document flows through all four
 * stages independently (extract → chunk → embed → index), so progress is NOT a
 * single global stage marching forward — at any instant docs are scattered
 * across stages and many may already be fully done. We therefore render each
 * stage bar from the fraction of the corpus that has passed THAT stage.
 */
type StageCounters = {
  total: number
  done: number
  failed: number
  skipped: number
  indexing: number
  embedding: number
  chunking: number
  extracting: number
  awaitingRetry: number
  pending: number
}

function readCounters(stats: unknown): StageCounters | null {
  if (!stats || typeof stats !== "object") return null
  const s = stats as Record<string, unknown>
  if (typeof s.total !== "number" || s.total <= 0) return null
  const n = (k: string): number => (typeof s[k] === "number" ? (s[k] as number) : 0)
  return {
    total: s.total,
    done: n("done"),
    failed: n("failed"),
    skipped: n("skipped"),
    indexing: n("indexing"),
    embedding: n("embedding"),
    chunking: n("chunking"),
    extracting: n("extracting"),
    // The worker emits these (callback.ts) but the stage bars don't consume
    // them — the outcomes line does, so a parked doc reads as "retrying"
    // instead of silently dragging the overall % down.
    awaitingRetry: n("awaiting_retry"),
    pending: n("pending"),
  }
}

/**
 * Linear ETA from per-doc throughput: (elapsed / completed) × remaining.
 * Rough by nature — documents vary from 2 to 800+ chunks — so it's prefixed
 * "~" and only shown once at least one document is terminal. Returns null when
 * not computable (no counters, nothing done yet, or already finished).
 */
function ingestEtaMs(job: IngestJob): number | null {
  const c = readCounters(job.stats)
  if (!c) return null
  const completed = c.done + c.skipped + c.failed
  if (completed < 1 || completed >= c.total) return null
  const startedAt = job.startedAt ?? job.createdAt
  if (!startedAt) return null
  const elapsed = Date.now() - new Date(startedAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null
  const remaining = c.total - completed
  return (elapsed / completed) * remaining
}

/** Compact, locale-neutral duration ("< 1 min", "~7 min", "~1 h 12 min"). */
function formatEtaShort(ms: number): string {
  if (ms < 60_000) return "< 1 min"
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `~${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `~${h} h` : `~${h} h ${m} min`
}

/**
 * Derive the display state for every stage. Prefers the per-doc counters
 * (`job.stats`) so all four bars advance as documents complete; falls back to
 * the legacy single-stage model when counters are absent (e.g. fake mode or an
 * old job row). Pure function — deterministic, no side-effects.
 */
function deriveStageInfos(job: IngestJob): StageInfo[] {
  const counters = readCounters(job.stats)

  // --- Counter-based model (preferred): one fraction per stage. ---
  if (counters && job.status !== INGEST_STATUS.FAILED && job.status !== INGEST_STATUS.CANCELED) {
    const c = counters
    const terminal = c.done + c.skipped + c.failed // fully-processed docs
    // Docs that have PASSED each stage (a doc currently in a stage hasn't
    // passed it yet). chunking/embedding are atomic in the worker, so those
    // bars track extract closely; index trails by the docs still indexing.
    const passed: Record<(typeof STAGE_ORDER)[number], number> = {
      [INGEST_STAGE.EXTRACT]: c.chunking + c.embedding + c.indexing + terminal,
      [INGEST_STAGE.CHUNK]: c.embedding + c.indexing + terminal,
      [INGEST_STAGE.EMBED]: c.indexing + terminal,
      [INGEST_STAGE.INDEX]: terminal,
    }
    return STAGE_ORDER.map((stage) => {
      if (job.status === INGEST_STATUS.DONE) return { stage, state: "done", progress: 100 }
      const fraction = Math.max(0, Math.min(1, passed[stage] / c.total))
      const pct = Math.round(fraction * 100)
      if (fraction >= 1) return { stage, state: "done", progress: 100 }
      if (pct > 0) return { stage, state: "running", progress: pct }
      return { stage, state: "pending", progress: 0 }
    })
  }

  // --- Legacy single-stage fallback. ---
  const currentStageIndex = job.stage
    ? STAGE_ORDER.indexOf(job.stage as (typeof STAGE_ORDER)[number])
    : -1

  // job.progress is a 0–1 fraction (Decimal from Prisma); scale to a 0–100
  // integer for display. (Was rounding the raw fraction → always 0%.)
  const jobProgress = Math.max(
    0,
    Math.min(100, Math.round(Number(job.progress ?? 0) * 100)),
  )

  return STAGE_ORDER.map((stage, idx) => {
    if (job.status === INGEST_STATUS.DONE) {
      return { stage, state: "done", progress: 100 }
    }

    if (job.status === INGEST_STATUS.FAILED) {
      if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
      if (idx === currentStageIndex) return { stage, state: "failed", progress: 0 }
      return { stage, state: "skipped", progress: 0 }
    }

    if (job.status === INGEST_STATUS.CANCELED) {
      if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
      return { stage, state: "skipped", progress: 0 }
    }

    // Running or queued
    if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
    if (idx === currentStageIndex) {
      return { stage, state: "running", progress: jobProgress }
    }
    return { stage, state: "pending", progress: 0 }
  })
}

/** The circular stage indicator: teal check (done), teal spinner (running),
 *  destructive cross (failed), dash (skipped), or the 1-based ordinal. */
function StageBadge({ state, ordinal }: { state: StageState; ordinal: number }) {
  const base =
    "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium"
  switch (state) {
    case "done":
      return (
        <span className={cn(base, "bg-brand-teal/20 text-brand-teal")}>
          <Check className="size-4" strokeWidth={2.5} />
        </span>
      )
    case "running":
      return (
        <span className={cn(base, "bg-brand-teal/20 text-brand-teal")}>
          <Loader2 className="size-4 animate-spin" strokeWidth={2.4} />
        </span>
      )
    case "failed":
      return (
        <span className={cn(base, "bg-destructive/15 text-destructive")}>
          <X className="size-4" strokeWidth={2.5} />
        </span>
      )
    case "skipped":
      return (
        <span className={cn(base, "bg-secondary text-muted-foreground")}>
          <Minus className="size-4" />
        </span>
      )
    case "pending":
      return (
        <span className={cn(base, "border bg-card font-mono text-muted-foreground")}>
          {ordinal}
        </span>
      )
  }
}

interface Props {
  job: IngestJob
  onCancel: () => void
}

export function CardIngestStagePipeline({ job, onCancel }: Props) {
  const tStages = useTranslations("ingest.stages")
  const tDesc = useTranslations("ingest.stageDesc")
  const tStatus = useTranslations("ingest.status")
  const tPipeline = useTranslations("ingest.pipeline")
  const tCancel = useTranslations("ingest.cancel")

  const tOutcomes = useTranslations("ingest.pipeline.outcomes")

  const stageInfos = deriveStageInfos(job)

  const isTerminal =
    job.status === INGEST_STATUS.DONE ||
    job.status === INGEST_STATUS.FAILED ||
    job.status === INGEST_STATUS.CANCELED

  // Per-doc outcome chips. Distinguishes a doc that is *retrying* (parked in
  // pg-boss backoff — transient, will resume) from one that is terminally
  // *skipped*/*failed*, and from a doc *excluded* at submission (a catalogue
  // notice never queued). Without this, a parked or excluded doc just makes the
  // overall % sit short of 100 and reads as a frozen pipeline.
  const counters = readCounters(job.stats)
  const excludedCount = job.excludedCount ?? 0
  const outcomes: { key: string; label: string; tone: string }[] = []
  if (counters) {
    if (counters.done > 0)
      outcomes.push({
        key: "ingested",
        label: tOutcomes("ingested", { count: counters.done }),
        tone: "text-brand-teal",
      })
    if (!isTerminal && counters.awaitingRetry > 0)
      outcomes.push({
        key: "retrying",
        label: tOutcomes("retrying", { count: counters.awaitingRetry }),
        tone: "text-amber-500",
      })
    if (counters.skipped > 0)
      outcomes.push({
        key: "skipped",
        label: tOutcomes("skipped", { count: counters.skipped }),
        tone: "text-muted-foreground",
      })
    if (counters.failed > 0)
      outcomes.push({
        key: "failed",
        label: tOutcomes("failed", { count: counters.failed }),
        tone: "text-destructive",
      })
  }
  if (excludedCount > 0)
    outcomes.push({
      key: "excluded",
      label: tOutcomes("excluded", { count: excludedCount }),
      tone: "text-muted-foreground",
    })

  // ETA: a number once enough is done, "estimating…" early in a running job.
  const etaMs = ingestEtaMs(job)
  const etaText = isTerminal
    ? null
    : etaMs != null
      ? formatEtaShort(etaMs)
      : tPipeline("etaComputing")

  // Overall progress: each completed stage contributes its full quarter; the
  // running stage contributes its fraction. Deterministic, no poll guessing.
  const overall = Math.round(
    stageInfos.reduce(
      (sum, s) => sum + (s.state === "done" ? 100 : s.state === "running" ? s.progress : 0),
      0,
    ) / stageInfos.length,
  )

  function statusLabel(state: StageState, progress: number): string {
    switch (state) {
      case "done":
        return tStatus("done")
      case "running":
        return `${progress}%`
      case "failed":
        return tStatus("failed")
      case "skipped":
        return tPipeline("skipped")
      case "pending":
        return tPipeline("pending")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tPipeline("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col">
          {stageInfos.map(({ stage, state, progress }, idx) => (
            <li
              key={stage}
              className="flex gap-3.5 border-b py-4 last:border-b-0"
            >
              <StageBadge state={state} ordinal={idx + 1} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[13.5px] font-semibold",
                      (state === "pending" || state === "skipped") &&
                        "text-muted-foreground",
                    )}
                  >
                    {tStages(stage as "extract")}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {statusLabel(state, progress)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {tDesc(stage as "extract")}
                </p>
                <span className="mt-2 block h-1.25 overflow-hidden rounded-full bg-secondary">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width] duration-500",
                      state === "failed" ? "bg-destructive" : "bg-brand-teal",
                    )}
                    style={{
                      width: `${state === "done" ? 100 : state === "running" ? progress : 0}%`,
                    }}
                  />
                </span>
              </div>
            </li>
          ))}
        </ol>

        {outcomes.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-[11px] tabular-nums">
            {outcomes.map((o) => (
              <li key={o.key} className="flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full bg-current", o.tone)} />
                <span className={o.tone}>{o.label}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <span className="text-xs text-muted-foreground">
            {tPipeline("target")} :{" "}
            <span className="font-mono text-neutral-200">
              {tPipeline("targetValue")}
            </span>
          </span>
          <div className="flex items-center gap-3">
            {etaText && (
              <span className="text-xs text-muted-foreground">
                {tPipeline("eta")} :{" "}
                <span className="font-mono text-neutral-200">{etaText}</span>
              </span>
            )}
            <span className="font-mono text-[13px] font-semibold text-brand-teal">
              {overall}%
            </span>
          </div>
        </div>

        {!isTerminal && (
          <div className="mt-4">
            <Button variant="destructive" size="sm" onClick={onCancel}>
              {tCancel("button")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
