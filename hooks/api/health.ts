"use client"
/**
 * TanStack Query hook for the workspace health indicator.
 *
 * useHealth — polls GET /api/health every HEALTH_POLL_MS and returns the
 * per-lane (app / alien / bnf) status snapshot the header renders.
 *
 * HTTP calls use apiFetch (basePath-aware); raw fetch() is forbidden.
 * See playbook/hooks.md.
 */
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import { HEALTH_POLL_MS } from "@/lib/constants"
import type { HealthSnapshot } from "@/models/health/schema"

export const healthKeys = {
  all: ["health"] as const,
}

/**
 * Poll workspace health. Refetches on a fixed interval AND in the background
 * (so the header keeps updating even when it isn't the focused tab). Returns
 * `undefined` data until the first response — the header treats that as a
 * neutral/idle state rather than an error.
 */
export function useHealth() {
  return useQuery<HealthSnapshot>({
    queryKey: healthKeys.all,
    queryFn: async () => {
      const res = await apiFetch("/api/health")
      if (!res.ok) throw new Error("Failed to fetch health")
      return res.json() as Promise<HealthSnapshot>
    },
    refetchInterval: HEALTH_POLL_MS,
    refetchIntervalInBackground: true,
    // Keep the last good snapshot visible while a refetch is in flight.
    placeholderData: (prev) => prev,
  })
}
