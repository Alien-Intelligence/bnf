"use client"

// hooks/api/documents.ts
// TanStack Query hooks for the documents model.
// All HTTP calls go through apiFetch — never raw fetch().
// Query keys are defined once at the top; never inlined at the call site.

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { DocumentOcrView } from "@/models/documents/schema"

const DOCUMENT_OCR_ENDPOINT = (projectId: string, ark: string) =>
  `/api/projects/${projectId}/documents/ocr?ark=${encodeURIComponent(ark)}`

// ── Query keys ────────────────────────────────────────────────────────────────

export const documentKeys = {
  ocr: (projectId: string, ark: string | null) => ["documents", projectId, "ocr", ark] as const,
}

// ── Read hooks ────────────────────────────────────────────────────────────────

/**
 * The OCR quality of one corpus document — its sync status, "Taux OCR" and
 * per-folio quality (feedback 2026-09-29 #7). Disabled while `ark` is null, so
 * it is safe to call unconditionally from a panel that may be closed.
 */
export function useDocumentOcr(projectId: string, ark: string | null) {
  return useQuery<DocumentOcrView>({
    queryKey: documentKeys.ocr(projectId, ark),
    queryFn: async () => {
      if (ark === null) throw new Error("useDocumentOcr: queryFn ran without an ARK")
      const res = await apiFetch(DOCUMENT_OCR_ENDPOINT(projectId, ark))
      if (!res.ok) throw new Error(`Failed to fetch document OCR quality: ${res.status}`)
      return res.json() as Promise<DocumentOcrView>
    },
    enabled: ark !== null,
  })
}
