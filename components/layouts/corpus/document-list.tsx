"use client"

// components/layouts/corpus/document-list.tsx
// Branches over loading / error / empty (filtered) / empty (fresh) / content.
// UI states are handled in explicit if-blocks per playbook/ui-states.md.
// Client component: receives onSelectArk and pagination callbacks.

import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { CardCorpusDocumentRow } from "@/components/cards/corpus/document-row"
import { CardCorpusDocumentRowSkeleton } from "@/components/cards/corpus/document-row-skeleton"
import { CardCorpusError } from "@/components/cards/corpus/error"
import { CardCorpusEmpty } from "@/components/cards/corpus/empty"
import { CardCorpusNoResults } from "@/components/cards/corpus/no-results"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  corpus?: CorpusSnapshot | null
  selectedArk?: string | null
  onSelectArk: (ark: string | null) => void
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  /** True when at least one filter is active (drives noResults vs. empty state). */
  hasActiveFilters: boolean
  /** True when additional pages can be fetched from the API. */
  hasNextPage: boolean
  /** True while a subsequent page is being fetched. */
  isFetchingNextPage: boolean
  /** Called when the user clicks the "Charger plus" button. */
  fetchNextPage: () => void
  /** Called when the user clears all active filters from the no-results state. */
  onClearFilters: () => void
}

export function LayoutCorpusDocumentList({
  corpus,
  selectedArk,
  onSelectArk,
  isLoading,
  isError,
  onRetry,
  hasActiveFilters,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onClearFilters,
}: Props) {
  const t = useTranslations("corpus.documents")

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

  // Empty (filtered) — filter set is too narrow, nothing matches.
  if ((!corpus || corpus.total === 0) && hasActiveFilters) {
    return <CardCorpusNoResults onClearFilters={onClearFilters} />
  }

  // Empty (fresh) — corpus has no documents yet.
  if (!corpus || corpus.total === 0) {
    return <CardCorpusEmpty />
  }

  // Content — render the (flattened, paginated) document rows.
  return (
    <div className="flex flex-col gap-2">
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

      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          {isFetchingNextPage ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("loadMore")}
            </>
          ) : (
            t("loadMore")
          )}
        </Button>
      )}
    </div>
  )
}
