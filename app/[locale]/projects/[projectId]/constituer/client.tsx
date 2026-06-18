"use client"

// app/[locale]/projects/[projectId]/constituer/client.tsx
// 40/60 layout client — owns interactivity, URL-driven filter + selection state,
// and the TanStack Query cache seed from the server-fetched initialCorpus.
// Filter changes navigate via router.push; selectedArk survives filter changes.

import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams, useRouter, usePathname } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useCorpusFlattened, corpusKeys } from "@/hooks/api/corpus"
import { useTurnStream } from "@/hooks/api/turn-stream"
import {
  corpusFiltersFromParams,
  corpusFiltersToParams,
  emptyCorpusFilters,
  hasActiveFilters,
  type CorpusFilters,
} from "@/models/corpus/types"
import { LayoutCorpusChat } from "@/components/layouts/corpus/chat"
import { LayoutSessionsSidebar } from "@/components/layouts/corpus/sessions-sidebar"
import { CardCorpusSummary } from "@/components/cards/corpus/summary"
import { CardCorpusFiltersDrawer } from "@/components/cards/corpus/filters-drawer"
import { LayoutCorpusDocumentList } from "@/components/layouts/corpus/document-list"
import { SheetDocumentDetail } from "@/components/sheets/corpus/document-detail"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import type { CorpusSnapshot } from "@/models/corpus/schema"
import type { AppSession } from "@/models/sessions/schema"

interface Props {
  locale: string
  projectId: string
  initialCorpus: CorpusSnapshot
  initialUser: { name?: string; email: string }
  initialSessionId: string
  initialSessions: AppSession[]
}

export function ConstituerClient({
  locale,
  projectId,
  initialCorpus,
  initialUser,
  initialSessionId,
  initialSessions,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // ── Active session state ──────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId)

  // ── Turn stream — lifted here so parent can observe domain events ─────────────
  const stream = useTurnStream(activeSessionId)

  // ── Debounced corpus refresh on corpus_event ─────────────────────────────────
  // When the agent adds or removes documents the corpus_event count grows.
  // We debounce 500 ms (trailing edge) so rapid mutations don't hammer the API.
  const CORPUS_REFRESH_DEBOUNCE_MS = 500
  const qc = useQueryClient()
  const corpusEventCountRef = useRef(0)
  const corpusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const currentCount = stream.domainEvents.filter(
      (e) => e.type === "corpus_event",
    ).length

    if (currentCount <= corpusEventCountRef.current) return

    corpusEventCountRef.current = currentCount

    if (corpusDebounceRef.current !== null) {
      clearTimeout(corpusDebounceRef.current)
    }

    corpusDebounceRef.current = setTimeout(() => {
      corpusDebounceRef.current = null
      void qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) })
    }, CORPUS_REFRESH_DEBOUNCE_MS)

    return () => {
      if (corpusDebounceRef.current !== null) {
        clearTimeout(corpusDebounceRef.current)
      }
    }
  }, [stream.domainEvents, projectId, qc])

  // ── Filter state — derived from URL ──────────────────────────────────────────
  const filters = useMemo(
    () => corpusFiltersFromParams(searchParams),
    [searchParams],
  )

  const onFiltersChange = (next: CorpusFilters) => {
    const params = corpusFiltersToParams(next)
    // Preserve the selected document ARK across filter changes.
    const sa = searchParams.get("selectedArk")
    if (sa) params.set("selectedArk", sa)
    router.push(`${pathname}?${params.toString()}`)
  }

  const onClearFilters = () => onFiltersChange(emptyCorpusFilters())

  // ── Selection state — also URL-driven ─────────────────────────────────────────
  const selectedArk = searchParams.get("selectedArk")

  const onSelectArk = (ark: string | null) => {
    const next = new URLSearchParams(searchParams.toString())
    if (ark) {
      next.set("selectedArk", ark)
    } else {
      next.delete("selectedArk")
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  // ── Data ──────────────────────────────────────────────────────────────────────
  const {
    snapshot,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useCorpusFlattened(projectId, filters, { initialSnapshot: initialCorpus })

  // The active-filters flag is derived from the URL filter state (not the
  // snapshot) so the noResults branch can show even while re-fetching.
  const filtersActive = hasActiveFilters(filters)

  const selectedDoc =
    selectedArk && snapshot
      ? (snapshot.sample.find((d) => d.ark === selectedArk) ?? null)
      : null

  // The comprehension panel components need a CorpusSnapshot; fall back to
  // the server-rendered initial snapshot while the first page loads.
  const displaySnapshot = snapshot ?? initialCorpus

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader user={initialUser} />
      <div className="flex flex-1 overflow-hidden">
        {/* Sessions sidebar — left strip, fixed width */}
        <div className="w-48 shrink-0 overflow-hidden">
          <LayoutSessionsSidebar
            projectId={projectId}
            scope="corpus"
            activeSessionId={activeSessionId}
            onActiveSessionChange={setActiveSessionId}
            initialSessions={initialSessions}
          />
        </div>

        {/* Main 40/60 grid */}
        <div className="grid grid-cols-[40%_60%] gap-4 p-6 flex-1 overflow-hidden">
          <LayoutCorpusChat stream={stream} projectId={projectId} locale={locale} />

          <div className="flex flex-col gap-4 overflow-auto">
            <CardCorpusSummary corpus={displaySnapshot} />
            <CardCorpusFiltersDrawer
              corpus={displaySnapshot}
              filters={filters}
              onChange={onFiltersChange}
            />
            <LayoutCorpusDocumentList
              corpus={snapshot}
              selectedArk={selectedArk}
              onSelectArk={onSelectArk}
              isLoading={isLoading}
              isError={isError}
              onRetry={() => void refetch()}
              hasActiveFilters={filtersActive}
              hasNextPage={hasNextPage ?? false}
              isFetchingNextPage={isFetchingNextPage}
              fetchNextPage={() => void fetchNextPage()}
              onClearFilters={onClearFilters}
            />
          </div>

          <SheetDocumentDetail
            doc={selectedDoc}
            open={!!selectedDoc}
            onOpenChange={(open) => {
              if (!open) onSelectArk(null)
            }}
          />
        </div>
      </div>
    </div>
  )
}
