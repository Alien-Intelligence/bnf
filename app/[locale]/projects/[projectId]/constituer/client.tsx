"use client"

// app/[locale]/projects/[projectId]/constituer/client.tsx
// 40/60 layout client — owns interactivity, filter + selection state, and the
// TanStack Query cache seed from the server-fetched initialCorpus.
//
// Filters/selection live in React STATE (not the URL): changing one refetches
// the corpus client-side via TanStack Query — no server round-trip / page
// reload. The URL is only MIRRORED (shallow history.replaceState) so the view is
// copy-paste/reload-able, and the initial state is seeded from it once on mount.

import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams, usePathname } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { useCorpusFlattened, corpusKeys } from "@/hooks/api/corpus"
import { memoryKeys } from "@/hooks/api/memory"
import { sessionKeys } from "@/hooks/api/sessions"
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
import { HelpCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { DialogOnboardingCorpus } from "@/components/dialogs/onboarding/corpus"
import { useMarkOnboardingSeen } from "@/hooks/api/onboarding"
import { ONBOARDING_INTRO } from "@/models/onboarding/schema"
import { SESSIONS_RAIL_WIDTH, AGENT_DEFAULT_MODEL, type AgentProvider } from "@/lib/constants"
import type { CorpusSnapshot } from "@/models/corpus/schema"
import type { AppSession } from "@/models/sessions/schema"

interface Props {
  locale: string
  projectId: string
  initialCorpus: CorpusSnapshot
  initialUser: { name?: string; email: string }
  initialSessionId: string
  initialSessions: AppSession[]
  introSeen: boolean
  /** Active agent provider (from env, server-rendered). Drives whether the chat
   *  model selector is shown. */
  agentProvider: AgentProvider
}

export function ConstituerClient({
  locale,
  projectId,
  initialCorpus,
  initialUser,
  initialSessionId,
  initialSessions,
  introSeen,
  agentProvider,
}: Props) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const t = useTranslations("corpus")

  // ── Onboarding intro — auto-open once per user; "?" reopens without resetting.
  const [introOpen, setIntroOpen] = useState(!introSeen)
  const markIntroSeen = useMarkOnboardingSeen()

  const onIntroOpenChange = (open: boolean) => {
    setIntroOpen(open)
    // Closing the intro (either the auto-open or a manual reopen) records it as
    // seen. Idempotent server-side, so reopening via "?" never resets it.
    if (!open && !introSeen) {
      markIntroSeen.mutate({ intro: ONBOARDING_INTRO.CORPUS })
    }
  }

  // ── Active session state ──────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId)

  // ── Selected model (openrouter only) ─────────────────────────────────────────
  // The selector switches the model for the next turn. Under the anthropic
  // provider there is nothing to switch, so we never send body.model (a
  // namespaced id would be rejected by the direct-Anthropic path).
  const [selectedModel, setSelectedModel] = useState<string>(AGENT_DEFAULT_MODEL)

  // ── Turn stream — lifted here so parent can observe domain events ─────────────
  const stream = useTurnStream(
    activeSessionId,
    agentProvider === "openrouter" ? selectedModel : undefined,
  )

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

  // ── Memory refresh on memory_event ───────────────────────────────────────────
  // When the agent writes to project memory, refresh the memory query so the
  // sidebar box + dialog reflect it without a reload. No debounce — memory
  // writes are infrequent.
  const memoryEventCountRef = useRef(0)
  useEffect(() => {
    const currentCount = stream.domainEvents.filter(
      (e) => e.type === "memory_event",
    ).length
    if (currentCount <= memoryEventCountRef.current) return
    memoryEventCountRef.current = currentCount
    void qc.invalidateQueries({ queryKey: memoryKeys.all(projectId, "corpus") })
  }, [stream.domainEvents, projectId, qc])

  // ── Reconcile panels when a turn finishes ─────────────────────────────────────
  // The corpus_event / memory_event live channel only fires for events the SDK
  // forwards mid-stream and can be missed, so the corpus count + document list
  // could go stale until a manual refresh. As a reliable safety net, refresh both
  // the corpus and memory queries whenever the agent's turn completes
  // (isStreaming true → false).
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const streaming = stream.isStreaming
    if (prevStreamingRef.current && !streaming) {
      void qc.invalidateQueries({ queryKey: corpusKeys.all(projectId) })
      void qc.invalidateQueries({ queryKey: memoryKeys.all(projectId, "corpus") })
      // A session's first turn auto-names it server-side — pull the new title.
      void qc.invalidateQueries({ queryKey: sessionKeys.list(projectId, "corpus") })
    }
    prevStreamingRef.current = streaming
  }, [stream.isStreaming, projectId, qc])

  // ── Filter + selection state (React state; seeded from the URL once) ──────────
  const [filters, setFilters] = useState<CorpusFilters>(() =>
    corpusFiltersFromParams(searchParams),
  )
  const [selectedArk, setSelectedArk] = useState<string | null>(() =>
    searchParams.get("selectedArk"),
  )

  const onFiltersChange = useCallback((next: CorpusFilters) => setFilters(next), [])
  const onClearFilters = useCallback(() => setFilters(emptyCorpusFilters()), [])
  const onSelectArk = useCallback((ark: string | null) => setSelectedArk(ark), [])

  // Mirror state → URL with a shallow history replace (NO Next navigation, so no
  // server round-trip / page reload). Purely for copy-paste + reload.
  useEffect(() => {
    const params = corpusFiltersToParams(filters)
    if (selectedArk) params.set("selectedArk", selectedArk)
    const qs = params.toString()
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname)
  }, [filters, selectedArk, pathname])

  // ── Data ──────────────────────────────────────────────────────────────────────
  // Seed the unfiltered head from the server; let filtered keys fetch fresh
  // (otherwise the unfiltered snapshot would seed a filtered key as if it
  // matched). keepPreviousData (in useCorpus) keeps the prior rows visible while
  // the new filter loads — isPlaceholderData flags that transition.
  const {
    snapshot,
    isLoading,
    isError,
    isPlaceholderData,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useCorpusFlattened(projectId, filters, {
    initialSnapshot: hasActiveFilters(filters) ? undefined : initialCorpus,
  })

  // "Updating" indicator: a filter change is in flight and we're showing the
  // previous result (placeholder). The background resolve-poll does NOT set this
  // (same key), so the overlay never strobes.
  const isFiltering = isPlaceholderData

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
      <WorkspaceHeader user={initialUser} projectId={projectId} />
      <div className="flex flex-1 overflow-hidden">
        {/* Sessions sidebar — left strip, fixed width */}
        <div
          className="shrink-0 overflow-hidden"
          style={{ width: SESSIONS_RAIL_WIDTH }}
        >
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
          <LayoutCorpusChat
            stream={stream}
            projectId={projectId}
            locale={locale}
            agentProvider={agentProvider}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
          />

          <div className="flex flex-col gap-4 overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t("panelTitle")}</h2>
              <button
                type="button"
                onClick={() => setIntroOpen(true)}
                title={t("help")}
                aria-label={t("help")}
                className="flex size-5.5 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:border-brand-teal/45 hover:text-brand-teal"
              >
                <HelpCircle className="size-3.5" />
              </button>
            </div>
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
              isFiltering={isFiltering}
            />
          </div>

          <SheetDocumentDetail
            doc={selectedDoc}
            projectId={projectId}
            open={!!selectedDoc}
            onOpenChange={(open) => {
              if (!open) onSelectArk(null)
            }}
          />
        </div>
      </div>

      <DialogOnboardingCorpus open={introOpen} onOpenChange={onIntroOpenChange} />
    </div>
  )
}
