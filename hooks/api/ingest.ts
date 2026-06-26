"use client"
/**
 * TanStack Query hooks for ingest job state.
 *
 * useIngestStatus   — polls GET /api/ingest/:job_id; stops when terminal.
 * useSubmitIngest   — POST /api/projects/:projectId/ingest.
 * useCancelIngest   — POST /api/ingest/:job_id/cancel.
 *
 * All HTTP calls use apiFetch (basePath-aware). Raw fetch() is forbidden.
 * See playbook/hooks.md and playbook/ingestion-jobs.md §"Progress reporting".
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import { INGEST_POLL_INTERVAL_MS } from "@/lib/constants"
import type {
  IngestJobStatusView,
  IngestJobView,
  IngestSubmitPaidOcrResponse,
} from "@/models/ingest/types"

/**
 * The submit endpoint returns either a bare job view (happy path) or a typed
 * paid-OCR outcome ({ kind, … }) the caller must surface to the user.
 * Discriminate on the presence of `kind`.
 */
export type SubmitIngestResult = IngestJobView | IngestSubmitPaidOcrResponse

/** Body accepted by the submit mutation. */
export type SubmitIngestVars = {
  targetVersionSeq?: number
  confirmPaidOcr?: boolean
}

/** Type guard: the submit returned a paid-OCR outcome, not a job. */
export function isPaidOcrOutcome(
  res: SubmitIngestResult,
): res is IngestSubmitPaidOcrResponse {
  return "kind" in res
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * Centralised key factory — never inline key arrays at call sites.
 * Invalidating `all(projectId)` covers every job key for that project.
 */
export const ingestKeys = {
  all: (projectId: string) => ["ingest", projectId] as const,
  job: (jobId: string) => ["ingest", "job", jobId] as const,
}

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

/**
 * Poll the status of a single ingest job.
 *
 * Polling stops automatically when the job reaches a terminal state
 * (done | failed | canceled). Pass null to disable the query entirely
 * (e.g. when no active job exists for the project).
 *
 * Prefer the SSE stream endpoint for real-time progress; this hook is the
 * fallback for clients that cannot sustain a long-lived connection.
 */
export function useIngestStatus(jobId: string | null) {
  return useQuery<IngestJobStatusView>({
    queryKey: jobId ? ingestKeys.job(jobId) : ["ingest", "noop"],
    enabled: !!jobId,
    queryFn: async () => {
      const res = await apiFetch(`/api/ingest/${jobId}`)
      if (!res.ok) throw new Error("Failed to fetch ingest job")
      return res.json() as Promise<IngestJobStatusView>
    },
    refetchInterval: (query) => {
      const status = (query.state.data as IngestJobStatusView | undefined)?.status
      return status === "running" || status === "queued"
        ? INGEST_POLL_INTERVAL_MS
        : false
    },
  })
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

/**
 * Submit an ingest job for a project.
 *
 * Submission is asynchronous — on the happy path the server returns the job row
 * immediately (track it with useIngestStatus) and deduplicates an in-flight job.
 * When the delta carries `sans_texte` documents, it instead returns a paid-OCR
 * outcome ({ kind: "confirmation_required" | "budget_exceeded" }); pass
 * `confirmPaidOcr: true` to authorize the spend and proceed. Use
 * {@link isPaidOcrOutcome} to discriminate.
 */
export function useSubmitIngest(projectId: string) {
  const qc = useQueryClient()
  return useMutation<SubmitIngestResult, Error, SubmitIngestVars>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to submit ingest")
      return res.json() as Promise<SubmitIngestResult>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ingestKeys.all(projectId) }),
  })
}

/**
 * Request cancellation of an in-flight ingest job.
 *
 * Cancellation is best-effort — the cluster worker may have already written
 * partial vectors. Those chunks are reconciled by the next successful ingest.
 * See playbook/ingestion-jobs.md §"Cancellation".
 */
export function useCancelIngest(projectId: string) {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (jobId) => {
      const res = await apiFetch(`/api/ingest/${jobId}/cancel`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Failed to cancel ingest")
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ingestKeys.all(projectId) }),
  })
}

/**
 * Retry the documents that failed in a previous ingest job.
 *
 * Takes `jobId` as the mutation variable. On success, invalidates all ingest
 * queries for the project so the new job appears immediately in the UI.
 *
 * Returns the new IngestJobView row created by IngestService.retryFailed().
 */
export function useRetryFailedIngest(projectId: string) {
  const qc = useQueryClient()
  return useMutation<IngestJobView, Error, string>({
    mutationFn: async (jobId) => {
      const res = await apiFetch(`/api/ingest/${jobId}/retry-failed`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Failed to retry failed documents")
      return res.json() as Promise<IngestJobView>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ingestKeys.all(projectId) }),
  })
}
