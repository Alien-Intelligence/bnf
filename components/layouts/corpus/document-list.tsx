"use client"

// components/layouts/corpus/document-list.tsx
// Branches over loading / error / empty / content for the corpus document list.
// UI states are handled in explicit if-blocks per playbook/ui-states.md.
// Client component: receives onSelectArk callback.

import { CardCorpusDocumentRow } from "@/components/cards/corpus/document-row"
import { CardCorpusDocumentRowSkeleton } from "@/components/cards/corpus/document-row-skeleton"
import { CardCorpusError } from "@/components/cards/corpus/error"
import { CardCorpusEmpty } from "@/components/cards/corpus/empty"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  corpus?: CorpusSnapshot | null
  selectedArk?: string | null
  onSelectArk: (ark: string | null) => void
  isLoading: boolean
  isError: boolean
  onRetry: () => void
}

export function LayoutCorpusDocumentList({
  corpus,
  selectedArk,
  onSelectArk,
  isLoading,
  isError,
  onRetry,
}: Props) {
  // Loading — mirror document row shape with skeletons.
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <CardCorpusDocumentRowSkeleton />
        <CardCorpusDocumentRowSkeleton />
        <CardCorpusDocumentRowSkeleton />
        <CardCorpusDocumentRowSkeleton />
      </div>
    )
  }

  // Error — visible, retriable, never silent.
  if (isError) {
    return <CardCorpusError onRetry={onRetry} />
  }

  // Empty — branch on total, NOT sample.length (sample is sampled).
  if (!corpus || corpus.total === 0) {
    return <CardCorpusEmpty />
  }

  // Content — render the sampled document rows.
  return (
    <ul className="flex flex-col gap-2 list-none p-0 m-0">
      {corpus.sample.map((doc) => (
        <li key={doc.ark}>
          <CardCorpusDocumentRow
            doc={doc}
            onClick={() =>
              onSelectArk(selectedArk === doc.ark ? null : doc.ark)
            }
          />
        </li>
      ))}
    </ul>
  )
}
