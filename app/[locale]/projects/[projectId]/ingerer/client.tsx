"use client"

// app/[locale]/projects/[projectId]/ingerer/client.tsx
// Ingérer step client component. Owns ingest job lifecycle state: submit,
// poll, cancel. Renders the pipeline card only while a job is active.
// No corpus mutation — ingest reads the corpus state set by Constituer.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  useIngestStatus,
  useSubmitIngest,
  useCancelIngest,
  useRetryFailedIngest,
  isPaidOcrOutcome,
} from "@/hooks/api/ingest"
import { CardIngestSummary } from "@/components/cards/ingest/summary"
import { CardIngestQueueStatus } from "@/components/cards/ingest/queue-status"
import { CardComeBackLater } from "@/components/cards/ingest/come-back-later"
import { CardIngestCompletion } from "@/components/cards/ingest/completion"
import { CardIngestRetryFailed } from "@/components/cards/ingest/retry-failed"
import { CardIngestJobHistory } from "@/components/cards/ingest/job-history"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { DialogIngestConfirmCancel } from "@/components/dialogs/ingest/confirm-cancel"
import {
  DialogIngestPaidOcrConfirm,
  type PaidOcrDialogState,
} from "@/components/dialogs/ingest/paid-ocr-confirm"
import type { IngestJobView } from "@/models/ingest/types"
import type { PaidOcrEstimate } from "@/models/ingest/schema"

interface Props {
  projectId: string
  initialUser: { name?: string; email: string }
  headVersionSeq: number
  ingestedVersionSeq: number | null
  deltaPreview: {
    added: number
    removed: number
    excluded: number
    paidOcr: PaidOcrEstimate
    paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
  }
  activeJobId: string | null
  initialRecentJobs: IngestJobView[]
}

export function IngererClient({
  projectId,
  initialUser,
  headVersionSeq,
  ingestedVersionSeq,
  deltaPreview,
  activeJobId: initialActiveJobId,
  initialRecentJobs,
}: Props) {
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

  // The delta panel (deltaPreview), ingested-version label, and job history are
  // server-rendered props computed at page load — they are NOT live queries.
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

  const { paidOcr, paidOcrBudget } = deltaPreview
  const canIncludePaidOcr = paidOcr.docCount > 0 && paidOcrBudget.withinBudget

  // Dispatch the ingest. `confirmPaidOcr` is true only after the librarian opted
  // in AND confirmed the spend; otherwise the regular delta runs alone and the
  // sans_texte docs are left untouched (never sent silently). A budget_exceeded
  // outcome (server backstop) opens the budget notice instead of starting a job.
  const dispatch = async (confirmPaidOcr: boolean) => {
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

  const onRetryFailed = async () => {
    if (!activeJobId) return
    const job = await retryMutation.mutateAsync(activeJobId)
    setActiveJobId(job.id)
  }

  const onCancel = () => setShowCancel(true)

  const confirmCancel = async () => {
    if (activeJobId) await cancelMutation.mutateAsync(activeJobId)
    setShowCancel(false)
  }

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader user={initialUser} projectId={projectId} />

      {/* *:shrink-0 — in a flex-col scroll container, items default to shrink:1
          and get squeezed below their content height when the column overflows;
          combined with the cards' overflow-hidden that clips their footers (e.g.
          the submit button). Keep natural heights → the container scrolls. */}
      <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full overflow-auto *:shrink-0">
        <CardIngestSummary
          headSeq={headVersionSeq}
          ingestedSeq={ingestedVersionSeq}
          delta={deltaPreview}
          paidOcrBudget={paidOcrBudget}
          includePaidOcr={includePaidOcr}
          onTogglePaidOcr={() => setIncludePaidOcr((v) => !v)}
          activeJob={status.data ?? null}
          onSubmit={onSubmit}
          isSubmitting={submitMutation.isPending}
        />

        <DialogIngestPaidOcrConfirm
          state={paidOcrDialog}
          onOpenChange={(open) => {
            if (!open) setPaidOcrDialog(null)
          }}
          onConfirm={onConfirmPaidOcr}
          isPending={submitMutation.isPending}
        />

        {activeJobId && status.data && (
          <>
            {/* Done: hand off to Rechercher. Partial: the successes ARE indexed,
                so also offer the success CTA, plus a retry for the failed docs. */}
            {(status.data.status === INGEST_STATUS.DONE ||
              status.data.status === INGEST_STATUS.PARTIAL) && (
              <CardIngestCompletion projectId={projectId} />
            )}

            {/* Live: the reassurance banner first, then the queue-status view
                (buckets draining, BnF fetch as the headline bottleneck). */}
            {(status.data.status === INGEST_STATUS.QUEUED ||
              status.data.status === INGEST_STATUS.RUNNING) && (
              <>
                <CardComeBackLater />
                <CardIngestQueueStatus job={status.data} onCancel={onCancel} />
              </>
            )}

            {/* Failed (whole job) or partial (some docs) → offer to retry the
                failed documents only. */}
            {(status.data.status === INGEST_STATUS.FAILED ||
              status.data.status === INGEST_STATUS.PARTIAL) && (
              <CardIngestRetryFailed
                error={status.data.error}
                onRetry={() => void onRetryFailed()}
                isRetrying={retryMutation.isPending}
              />
            )}
          </>
        )}

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
