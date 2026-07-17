"use client"

// hooks/api/admin.ts
// TanStack Query hooks for admin-only data.
// All HTTP calls go through apiFetch — never raw fetch().

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { AdminUsageResponse } from "@/app/api/admin/usage/route"
import type { AdminOverviewResponse } from "@/app/api/admin/overview/route"
import type { AdminAccountsResponse } from "@/app/api/admin/accounts/route"
import type { AdminFeedbackResponse } from "@/app/api/admin/feedback/route"

// ── Query keys ────────────────────────────────────────────────────────────────

export const adminKeys = {
  usage: () => ["admin", "usage"] as const,
  overview: () => ["admin", "overview"] as const,
  accounts: () => ["admin", "accounts"] as const,
  feedback: () => ["admin", "feedback"] as const,
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

/** Global platform statistics for the admin console Overview tab. */
export function useAdminOverview() {
  return useQuery<AdminOverviewResponse>({
    queryKey: adminKeys.overview(),
    queryFn: async () => {
      const res = await apiFetch("/api/admin/overview")
      if (!res.ok) throw new Error(`Failed to fetch overview: ${res.status}`)
      return res.json() as Promise<AdminOverviewResponse>
    },
    staleTime: 60_000,
  })
}

/** Per-account activity totals for the admin console Accounts tab. */
export function useAdminAccounts() {
  return useQuery<AdminAccountsResponse>({
    queryKey: adminKeys.accounts(),
    queryFn: async () => {
      const res = await apiFetch("/api/admin/accounts")
      if (!res.ok) throw new Error(`Failed to fetch accounts: ${res.status}`)
      return res.json() as Promise<AdminAccountsResponse>
    },
    staleTime: 60_000,
  })
}

/** Resolved feedback rows for the admin console Feedback tab. */
export function useAdminFeedback() {
  return useQuery<AdminFeedbackResponse>({
    queryKey: adminKeys.feedback(),
    queryFn: async () => {
      const res = await apiFetch("/api/admin/feedback")
      if (!res.ok) throw new Error(`Failed to fetch feedback: ${res.status}`)
      return res.json() as Promise<AdminFeedbackResponse>
    },
    staleTime: 60_000,
  })
}
