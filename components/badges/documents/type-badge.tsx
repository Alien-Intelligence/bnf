// components/badges/documents/type-badge.tsx
// Renders a document type badge using the DOC_TYPE vocabulary map.
// Falls back to the raw code + muted styling for unknown codes.
// Server component — no event handlers, no hooks.

import { Badge } from "@/components/ui/badge"
import { DOC_TYPE } from "@/models/documents/schema"

interface Props {
  code: string
}

export function BadgeDocumentType({ code }: Props) {
  const entry = DOC_TYPE[code]

  if (!entry) {
    return (
      <Badge className="bg-muted text-muted-foreground font-normal">
        {code}
      </Badge>
    )
  }

  return (
    <Badge className={`${entry.color} font-normal border-0`}>
      {entry.label}
    </Badge>
  )
}
