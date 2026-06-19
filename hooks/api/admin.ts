"use client"

// hooks/api/admin.ts
// TanStack Query hooks for admin-only data.
// All HTTP calls go through apiFetch — never raw fetch().

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { AdminUsageResponse } from "@/app/api/admin/usage/route"

// ── Query keys ────────────────────────────────────────────────────────────────

export const adminKeys = {
  usage: () => ["admin", "usage"] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/**
 * Fetches aggregate usage statistics for the admin dashboard.
 * Will return a 403 error if the current user is not an admin.
 */
export function useAdminUsage() {
  return useQuery<AdminUsageResponse>({
    queryKey: adminKeys.usage(),
    queryFn: async () => {
      const res = await apiFetch("/api/admin/usage")
      if (!res.ok) throw new Error(`Failed to fetch usage stats: ${res.status}`)
      return res.json() as Promise<AdminUsageResponse>
    },
    staleTime: 60_000,
  })
}
