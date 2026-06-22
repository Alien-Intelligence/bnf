"use client"

// components/cards/memory/section.tsx
// One titled section of the memory file, with a `##` mono eyebrow + rule
// (design/BnF Corpus Research.dc.html lines 883-888).

import { CardMemoryItem } from "./item"
import type { MemoryItem } from "@/models/memory/schema"

interface Props {
  section: { title: string; items: MemoryItem[] }
  projectId: string
  scope: "corpus" | "research"
}

export function CardMemorySection({ section, projectId, scope }: Props) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11px] text-brand-teal">##</span>
        <span className="font-mono text-xs font-semibold tracking-wide text-foreground/90">
          {section.title}
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="flex flex-col gap-0.5">
        {section.items.map((item) => (
          <CardMemoryItem key={item.id} item={item} projectId={projectId} scope={scope} />
        ))}
      </div>
    </div>
  )
}
