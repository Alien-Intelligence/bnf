"use client"

import { Badge } from "@/components/ui/badge"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface CitationPillProps {
  citation: ParsedCitation
  onClick: (c: ParsedCitation) => void
}

export function CitationPill({ citation, onClick }: CitationPillProps) {
  return (
    <button
      type="button"
      onClick={() => onClick(citation)}
      className="inline-block align-middle mx-0.5"
    >
      <Badge variant="secondary" className="font-mono text-xs">
        {citation.label} · f{citation.folio}
      </Badge>
    </button>
  )
}
