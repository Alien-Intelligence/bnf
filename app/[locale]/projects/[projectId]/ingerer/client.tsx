"use client"

// app/[locale]/projects/[projectId]/ingerer/client.tsx
// Ingérer step client component. Owns ingest job lifecycle state: submit, poll,
// cancel, retry. Derives the single de-geekified panel's `mode` from the active
// job + the delta preview, then renders CardIngestPanel (which absorbs the old
// summary / queue-status / come-back-later / completion / retry-failed cards).
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
import { CardIngestPanel, type IngestMode } from "@/components/cards/ingest/panel"
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
  /** Documents already consultable by the research assistant (indexed). */
  alreadyConsultable: number
  deltaPreview: {
    added: number
    removed: number
    excluded: number
    excludedNoText: number
    excludedNoScan: number
    paidOcr: PaidOcrEstimate
    paidOcrBudget: { spentUsd: number; ceilingUsd: number; withinBudget: boolean }
  }
  activeJobId: string | null
  initialRecentJobs: IngestJobView[]
}

/**
 * Map the active job + delta onto the panel's six librarian-facing modes. A live
 * or terminal job drives the mode directly; with no live job (or a canceled one)
 * the delta decides: nothing to do → up to date, else first-ever prep → empty,
 * else an incremental add → pending.
 */
function deriveMode(
  jobStatus: string | null,
  already: number,
  added: number,
  removed: number,
): IngestMode {
  switch (jobStatus) {
    case INGEST_STATUS.QUEUED:
    case INGEST_STATUS.RUNNING:
      return "running"
    case INGEST_STATUS.DONE:
      return "done"
    case INGEST_STATUS.PARTIAL:
    case INGEST_STATUS.FAILED:
      return "failed"
    default: {
      // No live job, or a canceled one — the delta decides.
      const hasAction = added > 0 || removed > 0
      if (!hasAction) return "uptodate"
      return already > 0 ? "pending" : "empty"
    }
  }
}

export function IngererClient({
  projectId,
  initialUser,
  alreadyConsultable,
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

  // A seeded/just-submitted job whose first poll hasn't landed yet is still
  // live — treat it as running so the panel doesn't flash a delta state.
  const jobStatus: string | null =
    status.data?.status ?? (activeJobId ? INGEST_STATUS.RUNNING : null)

  const mode = deriveMode(
    jobStatus,
    alreadyConsultable,
    deltaPreview.added,
    deltaPreview.removed,
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
          already={alreadyConsultable}
          delta={{
            added: deltaPreview.added,
            removed: deltaPreview.removed,
            excluded: deltaPreview.excluded,
            excludedNoText: deltaPreview.excludedNoText,
            excludedNoScan: deltaPreview.excludedNoScan,
            paidOcr: deltaPreview.paidOcr,
          }}
          paidOcrBudget={paidOcrBudget}
          includePaidOcr={includePaidOcr}
          onTogglePaidOcr={() => setIncludePaidOcr((v) => !v)}
          queue={status.data?.queue ?? null}
          doneCount={status.data?.addedCount ?? 0}
          isSubmitting={submitMutation.isPending}
          onSubmit={onSubmit}
          onRetry={() => void onRetryFailed()}
          onCancel={onCancel}
        />

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
