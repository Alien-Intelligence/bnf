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
import type { IngestJobView } from "@/models/ingest/types"

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
  return useQuery<IngestJobView>({
    queryKey: jobId ? ingestKeys.job(jobId) : ["ingest", "noop"],
    enabled: !!jobId,
    queryFn: async () => {
      const res = await apiFetch(`/api/ingest/${jobId}`)
      if (!res.ok) throw new Error("Failed to fetch ingest job")
      return res.json() as Promise<IngestJobView>
    },
    refetchInterval: (query) => {
      const status = (query.state.data as IngestJobView | undefined)?.status
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
 * The server returns the job row immediately — submission is asynchronous;
 * use useIngestStatus to track progress. The server deduplicates: if a job
 * for the same (projectId, targetVersionId) is already queued or running,
 * the same job row is returned.
 */
export function useSubmitIngest(projectId: string) {
  const qc = useQueryClient()
  return useMutation<IngestJobView, Error, { targetVersionSeq?: number }>({
    mutationFn: async (body) => {
      const res = await apiFetch(`/api/projects/${projectId}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to submit ingest")
      return res.json() as Promise<IngestJobView>
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
