"use client"

// app/[locale]/projects/[projectId]/ingerer/client.tsx
// Ingérer step client component. Owns ingest job lifecycle state: submit,
// poll, cancel. Renders the pipeline card only while a job is active.
// No corpus mutation — ingest reads the corpus state set by Constituer.

import { useState } from "react"
import {
  useIngestStatus,
  useSubmitIngest,
  useCancelIngest,
  useRetryFailedIngest,
  isPaidOcrOutcome,
} from "@/hooks/api/ingest"
import { CardIngestSummary } from "@/components/cards/ingest/summary"
import { CardIngestStagePipeline } from "@/components/cards/ingest/stage-pipeline"
import { CardComeBackLater } from "@/components/cards/ingest/come-back-later"
import { CardIngestCompletion } from "@/components/cards/ingest/completion"
import { CardIngestRetryFailed } from "@/components/cards/ingest/retry-failed"
import { CardIngestJobHistory } from "@/components/cards/ingest/job-history"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { DialogIngestConfirmCancel } from "@/components/dialogs/ingest/confirm-cancel"
import { DialogIngestPaidOcrConfirm } from "@/components/dialogs/ingest/paid-ocr-confirm"
import type {
  IngestJobView,
  IngestSubmitPaidOcrResponse,
} from "@/models/ingest/types"
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
  // Non-null while the paid-OCR dialog is open (confirmation or budget notice).
  const [paidOcrOutcome, setPaidOcrOutcome] =
    useState<IngestSubmitPaidOcrResponse | null>(null)

  const submitMutation = useSubmitIngest(projectId)
  const cancelMutation = useCancelIngest(projectId)
  const retryMutation = useRetryFailedIngest(projectId)
  const status = useIngestStatus(activeJobId)

  // Submit, then route the outcome: a job starts polling; a paid-OCR outcome
  // opens the confirmation/budget dialog instead. `confirmPaidOcr` re-submits
  // with the spend authorized.
  const submit = async (confirmPaidOcr: boolean) => {
    const res = await submitMutation.mutateAsync(
      confirmPaidOcr ? { confirmPaidOcr: true } : {},
    )
    if (isPaidOcrOutcome(res)) {
      setPaidOcrOutcome(res)
      return
    }
    setPaidOcrOutcome(null)
    setActiveJobId(res.id)
  }

  const onSubmit = () => submit(false)
  const onConfirmPaidOcr = () => submit(true)

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

      <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full overflow-auto">
        <CardIngestSummary
          headSeq={headVersionSeq}
          ingestedSeq={ingestedVersionSeq}
          delta={deltaPreview}
          activeJob={status.data ?? null}
          onSubmit={() => void onSubmit()}
          isSubmitting={submitMutation.isPending}
        />

        <DialogIngestPaidOcrConfirm
          outcome={paidOcrOutcome}
          onOpenChange={(open) => {
            if (!open) setPaidOcrOutcome(null)
          }}
          onConfirm={() => void onConfirmPaidOcr()}
          isPending={submitMutation.isPending}
        />

        {activeJobId && status.data && (
          status.data.status === INGEST_STATUS.DONE ? (
            <CardIngestCompletion projectId={projectId} />
          ) : (
            <>
              {/* "Traitement en cours / vous pouvez fermer la page" sits ABOVE
                  the stage progress bars — the reassurance banner first, the
                  detailed per-stage progress under it. */}
              {(status.data.status === INGEST_STATUS.QUEUED ||
                status.data.status === INGEST_STATUS.RUNNING) && (
                <CardComeBackLater />
              )}
              <CardIngestStagePipeline job={status.data} onCancel={onCancel} />
              {status.data.status === INGEST_STATUS.FAILED && (
                <CardIngestRetryFailed
                  error={status.data.error}
                  onRetry={() => void onRetryFailed()}
                  isRetrying={retryMutation.isPending}
                />
              )}
            </>
          )
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
