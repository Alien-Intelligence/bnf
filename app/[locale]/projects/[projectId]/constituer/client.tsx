"use client"

// app/[locale]/projects/[projectId]/constituer/client.tsx
// 40/60 layout client — owns interactivity, URL-driven selection state, and
// the TanStack Query cache seed from the server-fetched initialCorpus.
// No data fetching beyond the useCorpus hook.

import { useSearchParams, useRouter, usePathname } from "next/navigation"
import { useCorpus } from "@/hooks/api/corpus"
import { LayoutCorpusChat } from "@/components/layouts/corpus/chat"
import { CardCorpusSummary } from "@/components/cards/corpus/summary"
import { CardCorpusFiltersDrawer } from "@/components/cards/corpus/filters-drawer"
import { LayoutCorpusDocumentList } from "@/components/layouts/corpus/document-list"
import { SheetDocumentDetail } from "@/components/sheets/corpus/document-detail"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  projectId: string
  initialCorpus: CorpusSnapshot
  initialUser: { name?: string; email: string }
}

export function ConstituerClient({ projectId, initialCorpus, initialUser }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const selectedArk = searchParams.get("selectedArk")

  const {
    data: corpus,
    isLoading,
    isError,
    refetch,
  } = useCorpus(projectId, { initialData: initialCorpus })

  const onSelectArk = (ark: string | null) => {
    const next = new URLSearchParams(searchParams.toString())
    if (ark) {
      next.set("selectedArk", ark)
    } else {
      next.delete("selectedArk")
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  const selectedDoc =
    selectedArk && corpus
      ? (corpus.sample.find((d) => d.ark === selectedArk) ?? null)
      : null

  return (
    <div className="flex flex-col h-screen">
      <WorkspaceHeader user={initialUser} />
      <div className="grid grid-cols-[40%_60%] gap-4 p-6 flex-1 overflow-hidden">
        <LayoutCorpusChat projectId={projectId} />

        <div className="flex flex-col gap-4 overflow-auto">
          <CardCorpusSummary corpus={corpus ?? initialCorpus} />
          <CardCorpusFiltersDrawer corpus={corpus ?? initialCorpus} />
          <LayoutCorpusDocumentList
            corpus={corpus}
            selectedArk={selectedArk}
            onSelectArk={onSelectArk}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => void refetch()}
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
  )
}
