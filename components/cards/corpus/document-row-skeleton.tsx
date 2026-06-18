// components/cards/corpus/document-row-skeleton.tsx
// Skeleton placeholder that mirrors the shape of CardCorpusDocumentRow.
// Server component — pure static JSX, no hooks, no callbacks.

import { Skeleton } from "@/components/ui/skeleton"

export function CardCorpusDocumentRowSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card px-4 py-3">
      {/* Title */}
      <Skeleton className="h-4 w-2/3" />
      {/* Author + year */}
      <Skeleton className="h-3 w-1/3" />
      {/* Badges row */}
      <div className="flex gap-1">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-10 rounded-full" />
      </div>
      {/* Excerpt */}
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  )
}
