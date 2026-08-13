"use client"

// app/[locale]/projects/[projectId]/ingerer/client.tsx
// Ingérer step client component. Owns ingest job lifecycle state: submit, poll,
// cancel, retry. Derives the single de-geekified panel's `mode` from the active
// job + the delta preview, then renders CardIngestPanel (which absorbs the old
// summary / queue-status / come-back-later / completion / retry-failed cards).
// No corpus mutation — ingest reads the corpus state set by Constituer.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"
import {
  useIngestStatus,
  useSubmitIngest,
  useCancelIngest,
  useRetryFailedIngest,
  isPaidOcrOutcome,
} from "@/hooks/api/ingest"
import { CardIngestPanel, deriveMode } from "@/components/cards/ingest/panel"
import { CardIngestJobHistory } from "@/components/cards/ingest/job-history"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { DialogIngestConfirmCancel } from "@/components/dialogs/ingest/confirm-cancel"
import {
  DialogIngestPaidOcrConfirm,
  type PaidOcrDialogState,
} from "@/components/dialogs/ingest/paid-ocr-confirm"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import type { IngestDeltaPreview, IngestJobView } from "@/models/ingest/types"

interface Props {
  projectId: string
  initialUser: { name?: string; email: string }
  /** Server-computed delta preview (incl. the already-consultable count) — a
   *  page-load snapshot, refreshed on the live→terminal transition. */
  initialDeltaPreview: IngestDeltaPreview
  initialActiveJobId: string | null
  initialRecentJobs: IngestJobView[]
}

export function IngererClient({
  projectId,
  initialUser,
  initialDeltaPreview,
  initialActiveJobId,
  initialRecentJobs,
}: Props) {
  const t = useTranslations("ingest.panel.error")
  const { toast } = useToast()
  const [activeJobId, setActiveJobId] = useState<string | null>(
    initialActiveJobId,
  )
  const [showCancel, setShowCancel] = useState(false)
  // Whether the librarian has opted into paying for OCR of the sans_texte docs.
  const [includePaidOcr, setIncludePaidOcr] = useState(false)
  // Drives the paid-OCR dialog: client "confirm" before spending, or the
  // server "budget" backstop. Null = closed.
  const [paidOcrDialog, setPaidOcrDialog] = useState<PaidOcrDialogState>(null)

  const router = useRouter()
  const submitMutation = useSubmitIngest(projectId)
  const cancelMutation = useCancelIngest(projectId)
  const retryMutation = useRetryFailedIngest(projectId)
  const status = useIngestStatus(activeJobId)

  // The delta panel (deltaPreview), already-consultable count, and job history
  // are server-rendered props computed at page load — they are NOT live queries.
  // While a job runs, useIngestStatus polls, but the moment it goes terminal
  // those props are stale: the job committed (Document.indexedAt advanced, the
  // delta shrank) yet the panel still shows the pre-ingest counts until a manual
  // reload. Re-run the server component once on the live→terminal transition so
  // the counts and history reflect the committed result. router.refresh()
  // preserves client state (activeJobId, dialogs, scroll) — see Next.js
  // useRouter docs. Guarded by a ref so it fires exactly once per job (a page
  // loaded onto an already-terminal job never saw a live status, so no refresh).
  //
  // Seeded from initialActiveJobId: IngestQueries.activeForProject only returns
  // queued/running jobs, so a non-null initial id means the server rendered
  // while the job was live (delta is pre-completion). Seeding true covers the
  // race where the job finishes between server render and the first poll — the
  // first observed status is already terminal, but the panel still needs a
  // refresh.
  const wasLiveRef = useRef(Boolean(initialActiveJobId))
  useEffect(() => {
    const s = status.data?.status
    if (!s) return
    if (s === INGEST_STATUS.QUEUED || s === INGEST_STATUS.RUNNING) {
      wasLiveRef.current = true
    } else if (wasLiveRef.current) {
      wasLiveRef.current = false
      router.refresh()
    }
  }, [status.data?.status, router])

  const { paidOcr, paidOcrBudget } = initialDeltaPreview
  const canIncludePaidOcr = paidOcr.docCount > 0 && paidOcrBudget.withinBudget

  // Dispatch the ingest. `confirmPaidOcr` is true only after the librarian opted
  // in AND confirmed the spend; otherwise the regular delta runs alone and the
  // sans_texte docs are left untouched (never sent silently). A budget_exceeded
  // outcome (server backstop) opens the budget notice instead of starting a job.
  // A failed submit surfaces a toast — never a silent no-op (client-patterns §1).
  const dispatch = async (confirmPaidOcr: boolean) => {
    try {
      const res = await submitMutation.mutateAsync(
        confirmPaidOcr ? { confirmPaidOcr: true } : {},
      )
      if (isPaidOcrOutcome(res)) {
        setPaidOcrDialog({
          mode: "budget",
          usd: res.paidOcr.usd,
          spentUsd: res.spentUsd,
          ceilingUsd: res.ceilingUsd,
        })
        return
      }
      setPaidOcrDialog(null)
      setActiveJobId(res.id)
    } catch {
      toast(t("submit"))
    }
  }

  // Main CTA: if paid OCR is opted in (and affordable), confirm the spend first;
  // otherwise run the regular ingest immediately.
  const onSubmit = () => {
    if (canIncludePaidOcr && includePaidOcr) {
      setPaidOcrDialog({ mode: "confirm", docCount: paidOcr.docCount, usd: paidOcr.usd })
      return
    }
    void dispatch(false)
  }
  const onConfirmPaidOcr = () => void dispatch(true)

  const onRetryFailed = async (jobId: string | null = activeJobId) => {
    if (!jobId) return
    try {
      const job = await retryMutation.mutateAsync(jobId)
      setActiveJobId(job.id)
    } catch {
      toast(t("retry"))
    }
  }

  // The most recent TERMINAL job's failures, for the idle-mode retry notice.
  // initialRecentJobs is createdAt-desc; the first terminal entry is the last
  // run that finished. A newer successful run ranks first and correctly hides
  // the notice (its commit already re-indexed whatever recovered). Failures are
  // read from stats.failed (the worker's count, warnings excluded); a FAILED
  // job that never got stats (submit-transport failure) still surfaces with
  // count 0 — retryFailed's Document.indexError fallback handles the doc list.
  const lastTerminal = initialRecentJobs.find(
    (j) =>
      j.status === INGEST_STATUS.DONE ||
      j.status === INGEST_STATUS.PARTIAL ||
      j.status === INGEST_STATUS.FAILED,
  )
  const lastRunFailures =
    lastTerminal &&
    (lastTerminal.status === INGEST_STATUS.PARTIAL ||
      lastTerminal.status === INGEST_STATUS.FAILED)
      ? {
          jobId: lastTerminal.id,
          failedCount: Number(
            (lastTerminal.stats as Record<string, unknown> | null)?.failed ?? 0,
          ),
        }
      : null

  const onCancel = () => setShowCancel(true)

  const confirmCancel = async () => {
    if (!activeJobId) {
      setShowCancel(false)
      return
    }
    try {
      await cancelMutation.mutateAsync(activeJobId)
      setShowCancel(false)
    } catch {
      toast(t("cancel"))
    }
  }

  // A seeded/just-submitted job whose first poll hasn't landed yet is still
  // live — treat it as running so the panel doesn't flash a delta state. The
  // job keeps running server-side even if a poll fails, so an errored poll also
  // stays "running"; the failure is surfaced by the banner below, not swallowed.
  const jobStatus: string | null =
    status.data?.status ?? (activeJobId ? INGEST_STATUS.RUNNING : null)

  // Live-status polling failed (network/5xx) while a job is active — show a
  // visible, retriable notice instead of a silently-stuck view (ui-states §Error).
  const showPollError = Boolean(activeJobId) && status.isError

  const mode = deriveMode(
    jobStatus,
    initialDeltaPreview.already,
    initialDeltaPreview.added,
    initialDeltaPreview.removed,
  )

  return (
    <div className="flex h-screen flex-col">
      <WorkspaceHeader user={initialUser} projectId={projectId} />

      {/* *:shrink-0 — in a flex-col scroll container, items default to shrink:1
          and get squeezed below their content height when the column overflows.
          Keep natural heights → the container scrolls. */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 overflow-auto p-6 *:shrink-0">
        <CardIngestPanel
          mode={mode}
          projectId={projectId}
          already={initialDeltaPreview.already}
          delta={initialDeltaPreview}
          paidOcrBudget={paidOcrBudget}
          includePaidOcr={includePaidOcr}
          onTogglePaidOcr={() => setIncludePaidOcr((v) => !v)}
          queue={status.data?.queue ?? null}
          doneCount={status.data?.addedCount ?? 0}
          lastRunFailures={lastRunFailures}
          onRetryLast={() => void onRetryFailed(lastRunFailures?.jobId ?? null)}
          isSubmitting={submitMutation.isPending || retryMutation.isPending}
          onSubmit={onSubmit}
          onRetry={() => void onRetryFailed()}
          onCancel={onCancel}
        />

        {showPollError && (
          <Card className="border-warning/35 bg-warning/[0.08]">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-warning"
                strokeWidth={1.9}
              />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">{t("pollTitle")}</p>
                <p className="text-sm text-muted-foreground">{t("pollBody")}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto shrink-0"
                onClick={() => void status.refetch()}
              >
                {t("pollRetry")}
              </Button>
            </CardContent>
          </Card>
        )}

        <DialogIngestPaidOcrConfirm
          state={paidOcrDialog}
          onOpenChange={(open) => {
            if (!open) setPaidOcrDialog(null)
          }}
          onConfirm={onConfirmPaidOcr}
          isPending={submitMutation.isPending}
        />

        <CardIngestJobHistory projectId={projectId} jobs={initialRecentJobs} />
      </div>

      <DialogIngestConfirmCancel
        open={showCancel}
        onOpenChange={setShowCancel}
        onConfirm={() => void confirmCancel()}
        isPending={cancelMutation.isPending}
      />
    </div>
  )
}
